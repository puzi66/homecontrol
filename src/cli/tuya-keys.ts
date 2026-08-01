/**
 * Fetch Tuya local keys from the vendor cloud and store them locally.
 *
 *   npx tsx src/cli/tuya-keys.ts <accessId> <accessSecret>
 *   npx tsx src/cli/tuya-keys.ts            # reuses data/tuya.json
 *
 * Run once. Afterwards every Tuya command goes straight to the device over the
 * LAN and the cloud is never contacted again.
 *
 * Keys are masked on screen — they are credentials for controlling the devices,
 * and a terminal is a place they tend to linger.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { findDevicesAnyRegion, TUYA_REGIONS } from '../drivers/tuya-cloud.js';

const STORE = path.join(PATHS.data, 'tuya.json');

interface Store {
  accessId: string;
  accessSecret: string;
  region?: string;
  fetchedAt?: string;
  devices?: unknown[];
}

let accessId = process.argv[2];
let accessSecret = process.argv[3];

if (!accessId || !accessSecret) {
  try {
    const saved = JSON.parse(await fs.readFile(STORE, 'utf8')) as Store;
    accessId = saved.accessId;
    accessSecret = saved.accessSecret;
    console.log('using credentials from data/tuya.json\n');
  } catch {
    console.error('usage: npx tsx src/cli/tuya-keys.ts <accessId> <accessSecret>');
    process.exit(1);
  }
}

const mask = (key: string) =>
  key.length <= 6 ? '*'.repeat(key.length) : `${key.slice(0, 4)}${'*'.repeat(key.length - 4)}`;

console.log('asking every Tuya data centre (the wrong one returns an empty list, not an error)…\n');

const found = await findDevicesAnyRegion(accessId, accessSecret);

console.log('region checks:');
for (const p of found.probes) {
  const verdict = p.error
    ? /suspended/i.test(p.error)
      ? 'not enabled for this project (expected)'
      : p.error.slice(0, 70)
    : `authenticated, ${p.deviceCount} device(s)`;
  console.log(`  ${TUYA_REGIONS[p.region].label.padEnd(18)} ${verdict}`);
}
console.log();

if (!found.region) {
  console.error(found.diagnosis);
  process.exit(1);
}

console.log(`region: ${TUYA_REGIONS[found.region].label} (${found.region})`);
console.log(`${found.devices.length} device(s)\n`);

console.log(`${'NAME'.padEnd(26)}${'IP'.padEnd(16)}${'VER'.padEnd(6)}${'CATEGORY'.padEnd(12)}${'LOCAL KEY'.padEnd(18)}ONLINE`);
for (const d of found.devices) {
  console.log(
    `${d.name.slice(0, 24).padEnd(26)}${(d.ip ?? '-').padEnd(16)}${(d.version ?? '-').padEnd(6)}` +
      `${(d.category ?? '-').padEnd(12)}${mask(d.localKey).padEnd(18)}${d.online ? 'yes' : 'no'}`,
  );
}

await fs.mkdir(PATHS.data, { recursive: true });
await fs.writeFile(
  STORE,
  JSON.stringify(
    { accessId, accessSecret, region: found.region, fetchedAt: new Date().toISOString(), devices: found.devices },
    null,
    2,
  ),
  'utf8',
);

console.log(`\nsaved to data/tuya.json (gitignored)`);
