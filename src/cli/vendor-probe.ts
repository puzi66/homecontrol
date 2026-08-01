/**
 * Listen for vendor-specific broadcasts that identify devices we cannot yet
 * control: Switcher (Israeli water heaters / power plugs) and anything else
 * that announces itself on a known port.
 *
 *   npx tsx src/cli/vendor-probe.ts
 */
import dgram from 'node:dgram';
import net from 'node:net';

/** Ports that specific vendors broadcast their state on, unprompted. */
const LISTEN_PORTS = [
  { port: 20002, note: 'Switcher Touch / V2 / Mini' },
  { port: 20003, note: 'Switcher Breeze / Runner' },
  { port: 9957, note: 'Switcher control channel' },
];

const LISTEN_MS = 25_000;

const found = new Map<string, { port: number; bytes: number; head: string; ascii: string }>();

const sockets = await Promise.all(
  LISTEN_PORTS.map(
    ({ port }) =>
      new Promise<dgram.Socket>((resolve) => {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('error', () => resolve(s));
        s.on('message', (buf, rinfo) => {
          const key = `${rinfo.address}:${port}`;
          if (found.has(key)) return;
          found.set(key, {
            port,
            bytes: buf.length,
            head: buf.subarray(0, 16).toString('hex'),
            ascii: buf.toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 60),
          });
        });
        s.bind(port, () => resolve(s));
      }),
  ),
);

console.log(`listening ${LISTEN_MS / 1000}s on ${LISTEN_PORTS.map((p) => p.port).join(', ')}…\n`);
await new Promise((r) => setTimeout(r, LISTEN_MS));
for (const s of sockets) {
  try {
    s.close();
  } catch {
    /* already closed */
  }
}

console.log('═══ UDP broadcasts ═══');
if (found.size === 0) console.log('  nothing heard');
for (const [key, v] of found) {
  const note = LISTEN_PORTS.find((p) => p.port === v.port)?.note ?? '';
  console.log(`  ${key.padEnd(24)} ${v.bytes}B  ${note}`);
  console.log(`  ${''.padEnd(24)} hex   ${v.head}`);
  console.log(`  ${''.padEnd(24)} ascii ${v.ascii}`);
}

// Switcher's control channel is TCP 9957; a listening port is strong evidence
// even when the device happens not to broadcast during our window.
const targets = process.argv.slice(2).filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
if (targets.length > 0) {
  console.log('\n═══ TCP 9957 (Switcher control) ═══');
  for (const ip of targets) {
    const open = await new Promise<boolean>((resolve) => {
      const s = new net.Socket();
      let done = false;
      const fin = (v: boolean) => {
        if (done) return;
        done = true;
        s.destroy();
        resolve(v);
      };
      s.setTimeout(1500);
      s.once('connect', () => fin(true));
      s.once('timeout', () => fin(false));
      s.once('error', () => fin(false));
      s.connect(9957, ip);
    });
    console.log(`  ${ip.padEnd(16)} ${open ? 'OPEN — likely a Switcher device' : 'closed'}`);
  }
}
