/**
 * Join the Tuya cloud device list to the devices actually on this LAN.
 *
 *   npx tsx src/cli/tuya-match.ts
 *
 * The cloud knows each device's name and local key but reports only the site's
 * public IP, which is useless for talking to it. The LAN broadcast carries a
 * gwId that equals the cloud's device id — that is the join key, and this is
 * what turns a list of keys into "the office light is at 192.168.1.x".
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { discoverTuya } from '../discovery/tuya.js';
import type { TuyaCloudDevice } from '../drivers/tuya-cloud.js';

const STORE = path.join(PATHS.data, 'tuya.json');

let saved: { devices?: TuyaCloudDevice[] };
try {
  saved = JSON.parse(await fs.readFile(STORE, 'utf8'));
} catch {
  console.error('No data/tuya.json — run tuya-keys.ts first.');
  process.exit(1);
}

const cloud = saved.devices ?? [];
if (cloud.length === 0) {
  console.error('data/tuya.json has no devices.');
  process.exit(1);
}

console.log('listening 30s for Tuya broadcasts…\n');
const local = await discoverTuya(30_000);
const byId = new Map(local.map((l) => [l.gwId, l]));

const matched: { cloud: TuyaCloudDevice; ip: string; version: string }[] = [];

console.log(`${'NAME'.padEnd(26)}${'LAN ADDRESS'.padEnd(17)}${'PROTO'.padEnd(7)}CATEGORY`);
for (const device of cloud) {
  const seen = byId.get(device.id);
  if (seen) {
    matched.push({ cloud: device, ip: seen.ip, version: seen.version ?? '3.3' });
    console.log(
      `${device.name.slice(0, 24).padEnd(26)}${seen.ip.padEnd(17)}${(seen.version ?? '?').padEnd(7)}${device.category ?? '-'}`,
    );
  }
}

const unmatched = cloud.filter((d) => !byId.has(d.id));
if (unmatched.length > 0) {
  console.log(`\nNot on this network (${unmatched.length}):`);
  for (const d of unmatched) console.log(`  ${d.name}`);
}

const orphans = local.filter((l) => !cloud.some((c) => c.id === l.gwId));
if (orphans.length > 0) {
  console.log(`\nBroadcasting here but absent from the cloud account (${orphans.length}):`);
  for (const o of orphans) console.log(`  ${o.ip}  ${o.gwId}`);
}

// Persist the join so the driver can look a device up by address.
await fs.writeFile(
  STORE,
  JSON.stringify({ ...saved, matchedAt: new Date().toISOString(), matched }, null, 2),
  'utf8',
);

console.log(`\n${matched.length} device(s) matched and saved to data/tuya.json`);
