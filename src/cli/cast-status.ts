/**
 * Read the live status of every Cast device on the network. Read-only.
 *
 *   npx tsx src/cli/cast-status.ts [ip...]
 *
 * With no arguments it takes the Cast-capable hosts from the device ledger.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { withCast } from '../drivers/castv2.js';

let targets = process.argv.slice(2).filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));

if (targets.length === 0) {
  const ledger = JSON.parse(await fs.readFile(path.join(PATHS.data, 'seen.json'), 'utf8')) as {
    devices: { ip: string; openPorts: number[] }[];
  };
  targets = ledger.devices.filter((d) => d.openPorts.includes(8009)).map((d) => d.ip);
}

if (targets.length === 0) {
  console.error('no Cast devices found — run a scan first');
  process.exit(1);
}

console.log(`querying ${targets.length} device(s)\n`);

for (const ip of targets) {
  process.stdout.write(`${ip.padEnd(16)} `);
  try {
    const result = await withCast(ip, async (client) => {
      const receiver = await client.receiverStatus();
      const media = receiver.transportId ? await client.mediaStatus(receiver.transportId) : null;
      return { receiver, media };
    });

    const { receiver, media } = result;
    const volume = receiver.volumeLevel === null ? '?' : `${Math.round(receiver.volumeLevel * 100)}%`;
    console.log(`OK  vol=${volume}${receiver.muted ? ' (muted)' : ''}  app=${receiver.displayName ?? 'idle'}`);
    if (receiver.statusText) console.log(`${''.padEnd(16)}   status: ${receiver.statusText}`);
    if (media) {
      console.log(
        `${''.padEnd(16)}   media: ${media.playerState} — ${media.title ?? '?'}` +
          `${media.subtitle ? ` / ${media.subtitle}` : ''}`,
      );
    }
  } catch (err) {
    console.log(`FAILED  ${(err as Error).message}`);
  }
}
