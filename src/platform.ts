import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);
const log = logger('platform');

/**
 * What this machine can and cannot do, reported once at startup.
 *
 * The point is that the same code runs on a Windows desktop and on an Android
 * phone under Termux, with materially different capabilities — and a scan that
 * quietly finds half the devices is worse than one that says why. This makes the
 * degradation visible in the log instead of leaving it to be inferred.
 */

export interface Capabilities {
  platform: string;
  arch: string;
  /** True when we can read the OS neighbour table — the best host finder. */
  neighbourTable: boolean;
  neighbourTableVia: string | null;
  /** True when visible WiFi networks can be enumerated. */
  wifiScan: boolean;
  /** True when the default gateway can be identified. */
  gatewayLookup: boolean;
  /** Present when running under Termux on Android. */
  termux: boolean;
}

async function canRun(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 8000, windowsHide: true });
    return true;
  } catch (err) {
    // A non-zero exit still proves the binary exists and is runnable.
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ENOENT';
  }
}

async function readableProcArp(): Promise<boolean> {
  const fs = await import('node:fs/promises');
  try {
    await fs.access('/proc/net/arp');
    await fs.readFile('/proc/net/arp', 'utf8');
    return true;
  } catch {
    return false;
  }
}

export async function detectCapabilities(): Promise<Capabilities> {
  const isWindows = process.platform === 'win32';
  const termux = Boolean(process.env['TERMUX_VERSION'] ?? process.env['PREFIX']?.includes('com.termux'));

  let neighbourTableVia: string | null = null;

  if (isWindows) {
    neighbourTableVia = 'Get-NetNeighbor';
  } else if (await canRun('ip', ['-V'])) {
    neighbourTableVia = 'ip neigh';
  } else if (await canRun('arp', ['-a'])) {
    neighbourTableVia = 'arp -a';
  } else if (await readableProcArp()) {
    neighbourTableVia = '/proc/net/arp';
  }

  return {
    platform: `${process.platform} ${os.release()}`,
    arch: process.arch,
    neighbourTable: neighbourTableVia !== null,
    neighbourTableVia,
    wifiScan: isWindows,
    gatewayLookup: isWindows,
    termux,
  };
}

/** Log the capability report, loudly flagging anything that degrades discovery. */
export function reportCapabilities(caps: Capabilities): void {
  log.info(`${caps.platform} (${caps.arch})${caps.termux ? ' — Termux on Android' : ''}`);

  if (caps.neighbourTable) {
    log.info(`host discovery: ARP table via ${caps.neighbourTableVia}`);
  } else {
    log.warn(
      'host discovery: no neighbour table available, so scans fall back to a TCP ' +
        'liveness sweep. Devices with no open TCP port will not be found. On Termux, ' +
        '`pkg install iproute2` restores the ARP path on rooted devices only.',
    );
  }

  if (!caps.wifiScan) log.info('wifi listing: unavailable on this platform (Windows only)');
  if (!caps.gatewayLookup) log.info('gateway detection: unavailable on this platform (Windows only)');

  if (caps.termux) {
    log.warn(
      'Termux: Android will suspend this process unless a wake lock is held. ' +
        'Run `termux-wake-lock` or time-based automations will stop firing.',
    );
  }
}
