import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved whether we run from src/ (tsx) or dist/ (compiled). */
export const ROOT = path.resolve(here, '..');

/**
 * Load .env into process.env, if it exists.
 *
 * Hand-rolled rather than pulling in dotenv: we need `KEY=value`, comments and
 * optional quotes, which is about ten lines. Values already present in the real
 * environment win, so an explicit `HOMECONTROL_PORT=... pnpm start` still
 * overrides the file.
 */
function loadEnvFile(): void {
  const file = path.join(ROOT, '.env');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env is the normal case
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

export const PATHS = {
  root: ROOT,
  data: path.join(ROOT, 'data'),
  devices: path.join(ROOT, 'data', 'devices.json'),
  ouiCache: path.join(ROOT, 'data', 'oui-cache.json'),
  secrets: path.join(ROOT, 'data', 'secrets.json'),
  web: path.join(ROOT, 'src', 'web'),
};

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const CONFIG = {
  /** Port the dashboard + API listen on. */
  port: num('HOMECONTROL_PORT', 8123 + 1000),
  host: process.env['HOMECONTROL_HOST'] ?? '0.0.0.0',

  /**
   * Where the house is. Used only for local sunrise/sunset maths, so that
   * "switch the lights on at dusk" needs no internet.
   *
   * The default is Greenwich — a deliberate placeholder, not a guess at your
   * location. Set HOMECONTROL_LAT / HOMECONTROL_LON in .env, or sun-based
   * automations will fire at the wrong time. `locationConfigured` below drives
   * the startup warning that says so.
   */
  location: {
    latitude: num('HOMECONTROL_LAT', 51.4779),
    longitude: num('HOMECONTROL_LON', -0.0015),
  },
  locationConfigured: Boolean(process.env['HOMECONTROL_LAT'] && process.env['HOMECONTROL_LON']),

  /** Home Assistant base URL and long-lived access token. */
  ha: {
    url: process.env['HA_URL'] ?? 'http://127.0.0.1:8123',
    token: process.env['HA_TOKEN'] ?? '',
  },

  discovery: {
    /** Milliseconds to wait for each passive listener (mDNS/SSDP/miio). */
    listenMs: num('DISCOVERY_LISTEN_MS', 4000),
    /** Parallel sockets used during the ARP sweep. */
    sweepConcurrency: num('DISCOVERY_SWEEP_CONCURRENCY', 256),
    /**
     * TCP connect timeout when fingerprinting. Cheap IoT devices are slow to
     * accept, so anything under a second drops genuinely open ports.
     */
    portTimeoutMs: num('DISCOVERY_PORT_TIMEOUT_MS', 1500),
    /** Sockets open at once across the whole fingerprint pass. */
    portSocketBudget: num('DISCOVERY_PORT_SOCKETS', 96),
    /** Refuse to sweep a subnet larger than this many hosts. */
    maxSubnetHosts: num('DISCOVERY_MAX_SUBNET_HOSTS', 1024),
    /** Look vendors up online when the built-in OUI table misses. */
    onlineOuiLookup: process.env['DISCOVERY_ONLINE_OUI'] !== 'false',
  },
} as const;
