import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import type { WifiNetwork } from './types.js';

const execFileAsync = promisify(execFile);
const log = logger('wifi');

/**
 * Enumerate WiFi networks visible to this machine via `netsh wlan`.
 *
 * Note this lists access points in range, which is a different question from
 * "what is connected to my WiFi" — devices joined to the router appear in the
 * subnet sweep, not here, because they are ordinary IP hosts on the same LAN.
 */
export async function scanWifiNetworks(): Promise<WifiNetwork[]> {
  if (process.platform !== 'win32') {
    log.debug('wifi scan skipped: not Windows');
    return [];
  }

  const connectedSsid = await currentSsid();

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (err) {
    // No wireless adapter, or the WLAN service is stopped. Not an error for us.
    log.debug(`netsh wlan failed: ${(err as Error).message}`);
    return [];
  }

  const networks: WifiNetwork[] = [];
  let current: WifiNetwork | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // netsh is localised, so match on structure (the "SSID N :" prefix) as well
    // as the English label where possible.
    const ssidMatch = line.match(/^SSID\s+\d+\s*:\s*(.*)$/i);
    if (ssidMatch) {
      if (current) networks.push(current);
      const ssid = ssidMatch[1]!.trim();
      current = {
        ssid: ssid || '(hidden)',
        bssid: null,
        signal: null,
        channel: null,
        band: null,
        authentication: null,
        encryption: null,
        connected: !!ssid && ssid === connectedSsid,
      };
      continue;
    }

    if (!current) continue;

    const bssid = line.match(/^BSSID\s+\d+\s*:\s*([0-9a-fA-F:]{17})/);
    if (bssid) {
      current.bssid ??= bssid[1]!.toLowerCase();
      continue;
    }

    const signal = line.match(/(?:Signal|עוצמת אות)\s*:\s*(\d+)\s*%/i);
    if (signal) {
      current.signal ??= Number(signal[1]);
      continue;
    }

    const channel = line.match(/(?:Channel|ערוץ)\s*:\s*(\d+)/i);
    if (channel) {
      const ch = Number(channel[1]);
      current.channel ??= ch;
      current.band ??= ch > 180 ? '6 GHz' : ch > 14 ? '5 GHz' : '2.4 GHz';
      continue;
    }

    const auth = line.match(/(?:Authentication|אימות)\s*:\s*(.+)$/i);
    if (auth) {
      current.authentication ??= auth[1]!.trim();
      continue;
    }

    const enc = line.match(/(?:Encryption|הצפנה)\s*:\s*(.+)$/i);
    if (enc) current.encryption ??= enc[1]!.trim();
  }

  if (current) networks.push(current);

  log.debug(`found ${networks.length} wifi networks`);
  return networks.sort((a, b) => (b.signal ?? 0) - (a.signal ?? 0));
}

/** SSID this machine is currently associated with, or null. */
async function currentSsid(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('netsh', ['wlan', 'show', 'interfaces'], {
      timeout: 10_000,
      windowsHide: true,
    });
    // "SSID  : Name" but not "BSSID : aa:bb:..".
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^SSID\s*:\s*(.+)$/i);
      if (m) return m[1]!.trim();
    }
  } catch {
    /* no wireless interface */
  }
  return null;
}
