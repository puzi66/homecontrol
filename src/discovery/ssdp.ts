import dgram from 'node:dgram';
import { logger } from '../logger.js';

const log = logger('ssdp');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

export interface SsdpRecord {
  ip: string;
  /** Value of the SERVER header, e.g. "Linux/4.4 UPnP/1.0 Sonos/70.3". */
  server: string | null;
  /** Search target / device type URN. */
  st: string | null;
  /** LOCATION URL of the device description XML. */
  location: string | null;
  usn: string | null;
  /** friendlyName + modelName pulled from the description XML, when reachable. */
  friendlyName: string | null;
  modelName: string | null;
  manufacturer: string | null;
}

const SEARCH_TARGETS = [
  'ssdp:all',
  'upnp:rootdevice',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:device:ZonePlayer:1',   // Sonos
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:dial-multiscreen-org:service:dial:1',    // Chromecast / smart TVs
];

/** Broadcast M-SEARCH and collect responders for `listenMs`. */
export async function discoverSsdp(listenMs: number, localAddresses: string[]): Promise<SsdpRecord[]> {
  const byIp = new Map<string, SsdpRecord>();

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', (err) => log.debug(`socket error: ${err.message}`));

  socket.on('message', (buf, rinfo) => {
    if (localAddresses.includes(rinfo.address)) return;
    const headers = parseHeaders(buf.toString('utf8'));

    const existing = byIp.get(rinfo.address);
    const record: SsdpRecord = existing ?? {
      ip: rinfo.address,
      server: null,
      st: null,
      location: null,
      usn: null,
      friendlyName: null,
      modelName: null,
      manufacturer: null,
    };

    record.server ??= headers['server'] ?? null;
    record.location ??= headers['location'] ?? null;
    record.usn ??= headers['usn'] ?? null;
    // Prefer a specific device URN over the generic rootdevice answer.
    const st = headers['st'] ?? headers['nt'] ?? null;
    if (st && (!record.st || record.st === 'upnp:rootdevice')) record.st = st;

    byIp.set(rinfo.address, record);
  });

  await new Promise<void>((resolve) => socket.bind(0, resolve));
  try {
    socket.setBroadcast(true);
    socket.setMulticastTTL(4);
  } catch {
    /* not fatal */
  }

  for (const st of SEARCH_TARGETS) {
    const msg = Buffer.from(
      [
        'M-SEARCH * HTTP/1.1',
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"',
        'MX: 2',
        `ST: ${st}`,
        '',
        '',
      ].join('\r\n'),
      'utf8',
    );
    await new Promise<void>((resolve) => {
      socket.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR, () => resolve());
    });
  }

  await new Promise((r) => setTimeout(r, listenMs));
  socket.close();

  const records = [...byIp.values()];

  // Fetch each device's description XML for a human-readable name. Bounded and
  // best-effort: a device that does not answer within 2s simply stays unnamed.
  await Promise.all(records.map((r) => enrichFromLocation(r)));

  log.debug(`found ${records.length} SSDP responders`);
  return records;
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

async function enrichFromLocation(record: SsdpRecord): Promise<void> {
  if (!record.location) return;
  try {
    const url = new URL(record.location);
    // Only follow LOCATION headers that point back at the device itself.
    if (url.hostname !== record.ip) return;

    const res = await fetch(record.location, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return;
    const xml = await res.text();

    record.friendlyName = tag(xml, 'friendlyName');
    record.modelName = tag(xml, 'modelName');
    record.manufacturer = tag(xml, 'manufacturer');
  } catch {
    // Unreachable description URL is normal; leave the fields null.
  }
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return m?.[1]?.trim() || null;
}
