/**
 * Bind every UDP port smart-home gear is known to announce itself on, and
 * report anything that arrives.
 *
 *   npx tsx src/cli/wide-listen.ts [seconds]
 *
 * This is how the Switcher boiler turned up: it had no open TCP port and
 * answered no probe, but it had been broadcasting its whole state every four
 * seconds the entire time. Listening costs nothing and asks nothing of the
 * device, so it is worth trying before concluding that something is silent.
 */
import dgram from 'node:dgram';

const PORTS = [
  1900,  // ssdp (already covered, included for completeness)
  1982,  // yeelight
  3333,  // various esp firmwares
  4000,  // govee
  5000,  // upnp alt
  5577,  // magic home
  6666, 6667, 7000,   // tuya
  8080, 8081, 8888,   // http-ish announcements
  9999,  // tp-link kasa
  10000, // shelly / misc
  20002, 20003, // switcher
  30303, // generic esp discovery
  38899, // wiz
  48899, // hf-lpb / magic home config
  50000, 50222,
  56700, // lifx
  58866, // tuya alt
];

const seconds = Number(process.argv[2] ?? 60);
const heard = new Map<string, { port: number; bytes: number; hex: string; ascii: string; count: number }>();

const sockets = await Promise.all(
  PORTS.map(
    (port) =>
      new Promise<dgram.Socket | null>((resolve) => {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('error', () => resolve(null));
        s.on('message', (buf, rinfo) => {
          const key = `${rinfo.address}:${port}`;
          const seen = heard.get(key);
          if (seen) {
            seen.count += 1;
            return;
          }
          heard.set(key, {
            port,
            bytes: buf.length,
            hex: buf.subarray(0, 24).toString('hex'),
            ascii: buf.toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 70),
            count: 1,
          });
        });
        s.bind(port, () => resolve(s));
      }),
  ),
);

const bound = sockets.filter(Boolean).length;
console.log(`listening on ${bound}/${PORTS.length} ports for ${seconds}s…\n`);

await new Promise((r) => setTimeout(r, seconds * 1000));
for (const s of sockets) {
  try {
    s?.close();
  } catch {
    /* already closed */
  }
}

if (heard.size === 0) {
  console.log('nothing broadcast on any of those ports');
} else {
  console.log(`${heard.size} source(s):\n`);
  for (const [key, v] of [...heard].sort()) {
    console.log(`${key.padEnd(24)} ${String(v.bytes).padStart(4)}B  x${v.count}`);
    console.log(`  hex   ${v.hex}`);
    console.log(`  ascii ${v.ascii}`);
  }
}
