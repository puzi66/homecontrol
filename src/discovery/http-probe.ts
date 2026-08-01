import { logger } from '../logger.js';

const log = logger('http-probe');

/**
 * Read whatever a device's web interface says about itself.
 *
 * A surprising number of devices that reveal nothing over mDNS or SSDP will
 * happily serve a page with their model in the title, or a Server header naming
 * the firmware. It is the difference between "smart device, Espressif" and
 * "TP-Link extender" — and it costs one request against hosts we already know
 * have a web port open.
 */

export interface HttpBanner {
  ip: string;
  port: number;
  /** Contents of <title>, trimmed. */
  title: string | null;
  /** The Server response header. */
  server: string | null;
  /** Where a redirect pointed, which is often more telling than the page. */
  location: string | null;
  /** True when the device demanded credentials — itself a useful signal. */
  authRequired: boolean;
}

/** Ports worth asking, in the order most likely to answer. */
const WEB_PORTS = [80, 8080, 8081, 443, 8443];

/**
 * Things that identify a device rather than its web server. A title of
 * "index" or "login" tells us nothing, so those are dropped rather than
 * presented as if they meant something.
 */
const USELESS_TITLES = new Set([
  'index', 'login', 'home', 'welcome', 'document', 'untitled',
  'redirect', 'loading', 'error', '404 not found', 'web server',
]);

async function probeOne(ip: string, port: number, timeoutMs: number): Promise<HttpBanner | null> {
  const scheme = port === 443 || port === 8443 ? 'https' : 'http';

  try {
    const res = await fetch(`${scheme}://${ip}:${port}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'homecontrol/1.0 (device discovery)' },
    });

    const server = res.headers.get('server');
    const location = res.headers.get('location');
    const authRequired = res.status === 401;

    let title: string | null = null;
    // Only read the body for HTML, and only the first chunk of it.
    const type = res.headers.get('content-type') ?? '';
    if (/html|xml|^$/.test(type)) {
      const text = (await res.text()).slice(0, 8000);
      const raw = text.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim();
      if (raw && !USELESS_TITLES.has(raw.toLowerCase())) title = raw;
    }

    if (!title && !server && !location && !authRequired) return null;
    return { ip, port, title, server, location, authRequired };
  } catch {
    // TLS failures, resets and timeouts are all normal here.
    return null;
  }
}

/** Probe one host, stopping at the first port that says something. */
export async function grabBanner(
  ip: string,
  openPorts: number[],
  timeoutMs = 2500,
): Promise<HttpBanner | null> {
  for (const port of WEB_PORTS) {
    if (!openPorts.includes(port)) continue;
    const banner = await probeOne(ip, port, timeoutMs);
    if (banner) return banner;
  }
  return null;
}

/** Probe many hosts with a bounded number in flight. */
export async function grabBanners(
  hosts: { ip: string; openPorts: number[] }[],
  concurrency = 12,
  timeoutMs = 2500,
): Promise<Map<string, HttpBanner>> {
  const out = new Map<string, HttpBanner>();
  const targets = hosts.filter((h) => h.openPorts.some((p) => WEB_PORTS.includes(p)));

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const host = targets[cursor++]!;
      const banner = await grabBanner(host.ip, host.openPorts, timeoutMs);
      if (banner) out.set(host.ip, banner);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  log.debug(`read banners from ${out.size} of ${targets.length} web hosts`);
  return out;
}
