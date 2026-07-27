/**
 * Identify the devices a normal sweep can only label "smart device of some kind".
 *
 * Runs the vendor-specific probes — Tuya broadcasts, Broadlink discovery, an
 * extended TCP fingerprint and an HTTP banner grab — and prints what each
 * unknown host turns out to be.
 *
 *   npx tsx src/cli/identify.ts
 */
import net from 'node:net';
import { discoverBroadlink } from '../discovery/broadlink.js';
import { activeInterfaces, broadcastForCidr } from '../discovery/net.js';
import { discoverTuya } from '../discovery/tuya.js';

const interfaces = await activeInterfaces();
const primary = interfaces[0];
if (!primary) {
  console.error('no active network interface');
  process.exit(1);
}

const broadcasts = interfaces.map((i) => broadcastForCidr(i.cidr));
console.log(`local ${primary.address} · broadcasting to ${broadcasts.join(', ')}\n`);

// ── Broadlink first: it is request/response, so it finishes fast ────────
console.log('probing for Broadlink devices…');
const broadlink = await discoverBroadlink(primary.address, broadcasts, 6000);

// ── Tuya is passive: we have to wait for devices to announce themselves ─
console.log('listening for Tuya broadcasts (30s — they announce on their own schedule)…');
const tuya = await discoverTuya(30_000);

// ── Extended port fingerprint over every host either probe mentioned ────
const EXTRA_PORTS = [80, 443, 6668, 6667, 6053, 8080, 8888, 8081, 9999, 5577, 4000, 55443];

function checkPort(ip: string, port: number, timeoutMs = 900): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}

async function httpTitle(ip: string, port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://${ip}:${port}/`, { signal: AbortSignal.timeout(2500) });
    const server = res.headers.get('server');
    const body = await res.text();
    const title = body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
    return [server && `server: ${server}`, title && `title: ${title}`].filter(Boolean).join(' · ') || null;
  } catch {
    return null;
  }
}

const candidates = [...new Set([...broadlink.map((b) => b.ip), ...tuya.map((t) => t.ip)])];

// Also sweep the hosts passed on the command line, so unknowns can be checked
// even when they never answered a vendor probe.
for (const arg of process.argv.slice(2)) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(arg) && !candidates.includes(arg)) candidates.push(arg);
}

console.log(`\nfingerprinting ${candidates.length} host(s) on ${EXTRA_PORTS.length} ports…\n`);

const ports = new Map<string, number[]>();
await Promise.all(
  candidates.map(async (ip) => {
    const open = await Promise.all(EXTRA_PORTS.map(async (p) => ((await checkPort(ip, p)) ? p : null)));
    ports.set(ip, open.filter((p): p is number => p !== null));
  }),
);

// ── Report ─────────────────────────────────────────────────────────────

console.log('═══ Broadlink ═══');
if (broadlink.length === 0) console.log('  none answered');
for (const b of broadlink.sort((x, y) => x.ip.localeCompare(y.ip))) {
  console.log(`  ${b.ip.padEnd(16)} ${(b.model ?? `unknown type 0x${b.deviceType.toString(16)}`).padEnd(34)} ${b.mac ?? ''}`);
  if (b.name) console.log(`  ${''.padEnd(16)} name: ${b.name}`);
  console.log(`  ${''.padEnd(16)} type code 0x${b.deviceType.toString(16)}${b.locked ? ' · locked to an account' : ''}`);
}

console.log('\n═══ Tuya ═══');
if (tuya.length === 0) console.log('  none announced in the listen window');
for (const t of tuya.sort((x, y) => x.ip.localeCompare(y.ip))) {
  console.log(`  ${t.ip.padEnd(16)} protocol ${t.version ?? '?'}  ${t.active === false ? '(not bound)' : ''}`);
  console.log(`  ${''.padEnd(16)} gwId       ${t.gwId ?? '—'}`);
  console.log(`  ${''.padEnd(16)} productKey ${t.productKey ?? '—'}`);
}

console.log('\n═══ Open ports ═══');
for (const ip of candidates.sort()) {
  const open = ports.get(ip) ?? [];
  console.log(`  ${ip.padEnd(16)} ${open.length ? open.join(', ') : 'none of the probed ports'}`);
  for (const p of open) {
    if (p === 80 || p === 8080 || p === 8081 || p === 8888) {
      const banner = await httpTitle(ip, p);
      if (banner) console.log(`  ${''.padEnd(16)}   :${p} ${banner}`);
    }
  }
}
