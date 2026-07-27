import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG, PATHS } from '../config.js';
import { logger } from '../logger.js';

const log = logger('oui');

/**
 * Built-in vendor table, keyed by the 24-bit OUI without separators.
 *
 * Lets a scan work fully offline for common home-network hardware. Anything
 * missing is resolved online once and cached in data/oui-cache.json.
 *
 * RULE: every entry below has been checked against the IEEE registry. Do not
 * add prefixes from memory — vendors reassign and reuse them, and a wrong entry
 * here is worse than a missing one because it shadows the online lookup and
 * therefore never gets corrected. If you cannot verify it, leave it out and let
 * the fallback handle it.
 */
const BUILTIN: Record<string, string> = {
  // Routers, computers and consumer gear
  b0bbe5: 'Sagemcom Broadband SAS',
  '30e171': 'Hewlett Packard',
  e4f042: 'Google, Inc.',
  a0b53c: 'Vantiva Technologies Belgium',
  f0b040: 'Hunan FN-Link Technology',
  '001788': 'Philips Lighting BV',
  b04f13: 'Dell Inc.',
  bcdf58: 'Google, Inc.',
  '8cdef9': 'Beijing Xiaomi Mobile Software',
  '1cf29a': 'Google, Inc.',
  '709741': 'Arcadyan Corporation',
  '7828ca': 'Sonos, Inc.',
  d43538: 'Beijing Xiaomi Mobile Software',
  '9c8c6e': 'Samsung Electronics',
  c82832: 'Beijing Xiaomi Electronics',
  '3c6d66': 'NVIDIA Corporation',
  f83dc6: 'AzureWave Technology',
  '4c37de': 'AltoBeam Inc.',
  '205843': 'WNC Corporation',

  cc40d0: 'NETGEAR',
  b04e26: 'TP-LINK TECHNOLOGIES CO.,LTD.',
  '68ff7b': 'TP-LINK TECHNOLOGIES CO.,LTD.',

  // IoT silicon and smart-home brands
  dc4f22: 'Espressif Inc.',
  c82b96: 'Espressif Inc.',
  c44f33: 'Espressif Inc.',
  f4cfa2: 'Espressif Inc.',
  '2cf432': 'Espressif Inc.',
  b4e62d: 'Espressif Inc.',
  '349454': 'Espressif Inc.',
  '3c8427': 'Espressif Inc.',
  b4430d: 'Broadlink Pty Ltd',
  b4e842: 'Hong Kong Bouffalo Lab Limited',
  c8478c: 'Beken Corporation',
  b8060d: 'Tuya Smart Inc.',
  c0f853: 'Tuya Smart Inc.',
  '382ce5': 'Tuya Smart Inc.',
  '10d561': 'Tuya Smart Inc.',
  '54ef44': 'Lumi United Technology Co., Ltd',
  '086bd7': 'Silicon Laboratories',
  '502cc6': 'GREE ELECTRIC APPLIANCES, INC. OF ZHUHAI',
  ccb8a8: 'AMPAK Technology, Inc.',
  '347de4': 'SHENZHEN BILIAN ELECTRONIC CO.，LTD',
};

let cache: Record<string, string> | null = null;
/** Prefixes we already failed to resolve online, so we do not retry all scan long. */
const negativeCache = new Set<string>();

function ouiOf(mac: string): string | null {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.length >= 6 ? hex.slice(0, 6) : null;
}

async function loadCache(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(PATHS.ouiCache, 'utf8');
    cache = JSON.parse(raw) as Record<string, string>;
  } catch {
    cache = {};
  }
  return cache;
}

async function saveCache(): Promise<void> {
  if (!cache) return;
  try {
    await fs.mkdir(path.dirname(PATHS.ouiCache), { recursive: true });
    await fs.writeFile(PATHS.ouiCache, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    log.debug(`could not persist OUI cache: ${(err as Error).message}`);
  }
}

/**
 * Resolve the vendor for a MAC.
 *
 * Order: built-in table -> on-disk cache -> public API (once per prefix).
 * A locally administered address (bit 1 of the first octet) is randomised by
 * the device and carries no vendor information, so we say so explicitly.
 */
export async function lookupVendor(mac: string | null): Promise<string | null> {
  if (!mac) return null;
  const oui = ouiOf(mac);
  if (!oui) return null;

  const firstOctet = parseInt(oui.slice(0, 2), 16);
  if (Number.isFinite(firstOctet) && (firstOctet & 0b10) !== 0) {
    return 'Randomised MAC (private address)';
  }

  if (BUILTIN[oui]) return BUILTIN[oui]!;

  const disk = await loadCache();
  if (disk[oui]) return disk[oui]!;

  if (!CONFIG.discovery.onlineOuiLookup || negativeCache.has(oui)) return null;

  try {
    const res = await fetch(`https://api.maclookup.app/v2/macs/${oui}`, {
      signal: AbortSignal.timeout(4000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      negativeCache.add(oui);
      return null;
    }
    const body = (await res.json()) as { found?: boolean; company?: string };
    if (!body.found || !body.company) {
      negativeCache.add(oui);
      return null;
    }
    disk[oui] = body.company;
    await saveCache();
    return body.company;
  } catch {
    negativeCache.add(oui);
    return null;
  }
}

/** Resolve many MACs, sharing the cache and rate-limiting the online lookups. */
export async function lookupVendors(macs: (string | null)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(macs.filter((m): m is string => !!m))];

  // Serial with a small delay: the public API rate-limits at ~2 req/s, and a
  // typical scan only has a handful of prefixes it cannot resolve locally.
  for (const mac of unique) {
    const vendor = await lookupVendor(mac);
    if (vendor) out.set(mac, vendor);
    const oui = ouiOf(mac);
    if (oui && !BUILTIN[oui] && !(cache ?? {})[oui]) {
      await new Promise((r) => setTimeout(r, 550));
    }
  }

  return out;
}
