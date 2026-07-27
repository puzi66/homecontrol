/**
 * Diagnose miio reachability: `pnpm tsx src/cli/miio-probe.ts [ip...]`
 *
 * Sends the handshake directly to each address, then repeats it as a subnet
 * broadcast, so we can tell a device that is silent apart from one where the
 * broadcast itself is not being delivered.
 */
import { discoverMiio, probeMiio } from '../discovery/miio.js';
import { activeInterfaces, broadcastForCidr } from '../discovery/net.js';

const targets = process.argv.slice(2);

if (targets.length > 0) {
  console.log('--- direct unicast probes ---');
  for (const ip of targets) {
    const res = await probeMiio(ip, 3000);
    console.log(`${ip.padEnd(16)} ${res ? JSON.stringify(res) : 'no response'}`);
  }
}

const interfaces = await activeInterfaces();
const broadcasts = interfaces.map((i) => broadcastForCidr(i.cidr));

console.log(`\n--- broadcast to ${broadcasts.join(', ')} ---`);
const found = await discoverMiio(5000, broadcasts);
if (found.length === 0) console.log('no responders');
for (const r of found) {
  console.log(
    `${r.ip.padEnd(16)} id=${r.deviceId} uptime=${r.stamp}s token=${r.token ?? 'withheld'}`,
  );
}
