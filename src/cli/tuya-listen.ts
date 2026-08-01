/**
 * Raw Tuya UDP listener — dumps whatever arrives, parsed or not.
 *
 * The normal discovery path only reports frames it could decode. When nothing
 * shows up it is worth knowing whether the devices are silent or whether our
 * decoder is at fault, and those look identical from the outside.
 */
import dgram from 'node:dgram';

const PORTS = [6666, 6667, 7000];
const LISTEN_MS = 45_000;

let count = 0;

const sockets = await Promise.all(
  PORTS.map(
    (port) =>
      new Promise<dgram.Socket>((resolve) => {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('error', (err) => {
          console.log(`  port ${port}: bind failed — ${err.message}`);
          resolve(s);
        });
        s.on('message', (buf, rinfo) => {
          count += 1;
          console.log(`\n[${port}] from ${rinfo.address}  ${buf.length} bytes`);
          console.log(`  hex   ${buf.subarray(0, 32).toString('hex')}`);
          console.log(`  ascii ${buf.toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 90)}`);
        });
        s.bind(port, () => {
          console.log(`  listening on ${port}`);
          resolve(s);
        });
      }),
  ),
);

console.log(`\nwaiting ${LISTEN_MS / 1000}s…`);
await new Promise((r) => setTimeout(r, LISTEN_MS));
for (const s of sockets) {
  try {
    s.close();
  } catch {
    /* already closed */
  }
}

console.log(`\n${count} datagram(s) received`);
if (count === 0) {
  console.log('Nothing at all — the devices are not broadcasting, or inbound UDP is blocked.');
}
