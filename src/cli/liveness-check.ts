/**
 * Compare the two host-discovery methods on this network.
 *
 *   npx tsx src/cli/liveness-check.ts
 *
 * The ARP sweep is what a Windows or Linux desktop uses. The TCP liveness sweep
 * is the fallback on Android, where the neighbour table is off-limits. Running
 * both side by side turns "you will find fewer devices on a phone" into an
 * actual number for your network, and names the devices that would be missed.
 */
import { pokeSubnet, readArpTable } from '../discovery/arp.js';
import { tcpLivenessSweep } from '../discovery/liveness.js';
import { activeInterfaces, hostsInCidr, ipToInt } from '../discovery/net.js';
import { detectCapabilities, reportCapabilities } from '../platform.js';

const caps = await detectCapabilities();
reportCapabilities(caps);

const interfaces = await activeInterfaces();
const primary = interfaces[0];
if (!primary) {
  console.error('no active interface');
  process.exit(1);
}

console.log(`\nsubnet ${primary.cidr}\n`);

// --- method 1: ARP ------------------------------------------------------
console.log('ARP sweep (desktop path)…');
await pokeSubnet(primary.cidr, 256, 1024);
const arp = (await readArpTable()).filter((e) => e.ip.startsWith(primary.cidr.split('/')[0]!.replace(/\.\d+$/, '.')));
const arpIps = new Set(arp.map((e) => e.ip));
console.log(`  found ${arpIps.size} hosts\n`);

// --- method 2: TCP liveness --------------------------------------------
console.log('TCP liveness sweep (Android path)…');
const candidates = hostsInCidr(primary.cidr, 1024);
const live = await tcpLivenessSweep(candidates);
const liveIps = new Set(live.map((h) => h.ip));
console.log(`  found ${liveIps.size} hosts\n`);

// --- the gap -----------------------------------------------------------
const missed = [...arpIps].filter((ip) => !liveIps.has(ip)).sort((a, b) => ipToInt(a) - ipToInt(b));
const extra = [...liveIps].filter((ip) => !arpIps.has(ip)).sort((a, b) => ipToInt(a) - ipToInt(b));

console.log('═'.repeat(60));
console.log(`ARP:  ${arpIps.size} hosts`);
console.log(`TCP:  ${liveIps.size} hosts`);
console.log(`\nInvisible to the Android path (${missed.length}):`);
for (const ip of missed) {
  const mac = arp.find((e) => e.ip === ip)?.mac ?? '-';
  console.log(`  ${ip.padEnd(16)} ${mac}`);
}
if (extra.length > 0) {
  console.log(`\nFound only by TCP (${extra.length}) — ARP entry had expired:`);
  for (const ip of extra) console.log(`  ${ip}`);
}
