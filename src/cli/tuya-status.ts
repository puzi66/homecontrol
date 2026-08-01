/**
 * Read the live data points from every matched Tuya device. Read-only.
 *
 *   npx tsx src/cli/tuya-status.ts
 *
 * This is the end-to-end check for local control: it proves the local key is
 * right, the protocol version was detected correctly and — on 3.4 — that the
 * session key negotiation completes. Nothing is actuated.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { withTuya } from '../drivers/tuya-local.js';
import type { TuyaCloudDevice } from '../drivers/tuya-cloud.js';

interface Matched {
  cloud: TuyaCloudDevice;
  ip: string;
  version: string;
}

const store = JSON.parse(await fs.readFile(path.join(PATHS.data, 'tuya.json'), 'utf8')) as {
  matched?: Matched[];
};

const matched = store.matched ?? [];
if (matched.length === 0) {
  console.error('No matched devices — run tuya-match.ts first.');
  process.exit(1);
}

for (const entry of matched) {
  const { cloud, ip, version } = entry;
  process.stdout.write(`${cloud.name.padEnd(24)} ${ip.padEnd(16)} v${version}  `);
  try {
    const status = await withTuya(ip, cloud.id, cloud.localKey, version, (d) => d.status());
    console.log(`OK  dps=${JSON.stringify(status.dps)}`);
  } catch (err) {
    console.log(`FAILED  ${(err as Error).message}`);
  }
}
