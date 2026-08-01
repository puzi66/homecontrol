/**
 * Register every matched Tuya device, wired up and ready to control.
 *
 *   npx tsx src/cli/tuya-adopt.ts
 *
 * Reads the join produced by tuya-match and pushes each device into the running
 * server's registry with its id, local key and protocol version already set, so
 * there is nothing to copy by hand.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG, PATHS } from '../config.js';
import type { TuyaCloudDevice } from '../drivers/tuya-cloud.js';

interface Matched {
  cloud: TuyaCloudDevice;
  ip: string;
  version: string;
}

const base = `http://127.0.0.1:${CONFIG.port}`;

const store = JSON.parse(await fs.readFile(path.join(PATHS.data, 'tuya.json'), 'utf8')) as {
  matched?: Matched[];
};
const matched = store.matched ?? [];

if (matched.length === 0) {
  console.error('No matched devices — run tuya-match.ts first.');
  process.exit(1);
}

/** Light strips and bulbs are lights; sockets and breakers are plugs. */
function kindFor(category: string | null): string {
  if (!category) return 'iot';
  if (['dd', 'dj', 'xdd', 'fwd', 'dc', 'tgq'].includes(category)) return 'light';
  if (['cz', 'pc', 'tdq', 'kg'].includes(category)) return 'plug';
  if (category === 'pir') return 'sensor';
  return 'iot';
}

let added = 0;

for (const { cloud, ip, version } of matched) {
  const body = {
    ip,
    name: cloud.name,
    kind: kindFor(cloud.category),
    driver: 'tuya',
    driverConfig: { deviceId: cloud.id, localKey: cloud.localKey, version },
  };

  try {
    const res = await fetch(`${base}/api/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { device?: { id: string }; error?: string };

    if (!res.ok) {
      console.log(`${cloud.name.padEnd(24)} FAILED  ${json.error}`);
      continue;
    }

    // Adoption keys on MAC when the scan knew one, so patch the config in
    // separately rather than assuming the POST carried it through.
    await fetch(`${base}/api/devices/${encodeURIComponent(json.device!.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ driver: 'tuya', driverConfig: body.driverConfig, kind: body.kind }),
    });

    console.log(`${cloud.name.padEnd(24)} ${ip.padEnd(16)} v${version}  registered as ${body.kind}`);
    added += 1;
  } catch (err) {
    console.log(`${cloud.name.padEnd(24)} FAILED  ${(err as Error).message}`);
  }
}

console.log(`\n${added} device(s) registered. Open the dashboard to control them.`);
