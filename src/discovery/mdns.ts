import dgram from 'node:dgram';
import { logger } from '../logger.js';
import { TYPE, decodeMessage, encodeQuery } from './dns-wire.js';

const log = logger('mdns');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

/**
 * Service types worth asking about directly. `_services._dns-sd._udp` enumerates
 * everything a responder offers, but many devices only answer specific queries,
 * so we ask for the common smart-home ones by name too.
 */
const SERVICE_TYPES = [
  '_services._dns-sd._udp.local',
  '_hap._tcp.local',            // HomeKit accessories
  '_googlecast._tcp.local',     // Chromecast / Nest
  '_sonos._tcp.local',          // Sonos
  '_hue._tcp.local',            // Philips Hue bridge
  '_miio._udp.local',           // Xiaomi / Dreame / MOVA ecosystem
  '_airplay._tcp.local',
  '_raop._tcp.local',           // AirPlay audio
  '_spotify-connect._tcp.local',
  '_printer._tcp.local',
  '_ipp._tcp.local',
  '_http._tcp.local',
  '_workstation._tcp.local',
  '_smb._tcp.local',
  '_ssh._tcp.local',
  '_homeassistant._tcp.local',
  '_esphomelib._tcp.local',     // ESPHome nodes
  '_ewelink._tcp.local',        // Sonoff / eWeLink LAN mode
  '_tasmota._tcp.local',
  '_shelly._tcp.local',
  '_matter._tcp.local',
  '_matterc._udp.local',        // Matter commissionable
  '_dreame._tcp.local',
];

export interface MdnsRecord {
  ip: string;
  /** Instance or host name, e.g. "Kitchen speaker" or "hue-bridge.local". */
  name: string | null;
  /** The name the owner gave the device, when it advertises one. */
  friendlyName: string | null;
  /** Model string, e.g. "Google Nest Hub" or "BSB002". */
  model: string | null;
  /** HomeKit accessory category, decoded from the `ci` TXT field. */
  category: string | null;
  /** Service types this address answered for. */
  services: string[];
  /** Flattened TXT key/value pairs across all records from this address. */
  txt: Record<string, string>;
  /** Ports advertised via SRV. */
  ports: number[];
}

/**
 * HomeKit accessory categories from the `ci` TXT field.
 *
 * This is the most precise identification mDNS offers — the device states what
 * it is rather than leaving it to be inferred from a MAC prefix.
 */
const HOMEKIT_CATEGORIES: Record<string, string> = {
  '1': 'other', '2': 'bridge', '3': 'fan', '4': 'garage door', '5': 'lightbulb',
  '6': 'door lock', '7': 'outlet', '8': 'switch', '9': 'thermostat', '10': 'sensor',
  '11': 'security system', '12': 'door', '13': 'window', '14': 'window covering',
  '15': 'programmable switch', '16': 'range extender', '17': 'camera',
  '18': 'video doorbell', '19': 'air purifier', '20': 'heater', '21': 'air conditioner',
  '22': 'humidifier', '23': 'dehumidifier', '28': 'sprinkler', '29': 'faucet',
  '30': 'shower head', '31': 'television', '32': 'remote', '33': 'router',
  '34': 'audio receiver', '35': 'tv set-top box', '36': 'tv stick',
};

/**
 * TXT keys that carry a human-chosen name, most specific first.
 * `fn` is what Chromecast and Nest devices publish — the name set in the app.
 */
const NAME_KEYS = ['fn', 'friendlyName', 'n', 'name'];
const MODEL_KEYS = ['md', 'model', 'ty', 'mdl'];

/**
 * Send mDNS queries on every local interface and collect answers for `listenMs`.
 * Results are keyed by source IP, which is what we need to join onto ARP data.
 */
export async function discoverMdns(listenMs: number, localAddresses: string[]): Promise<MdnsRecord[]> {
  const byIp = new Map<string, MdnsRecord>();

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', (err) => log.debug(`socket error: ${err.message}`));

  socket.on('message', (buf, rinfo) => {
    const msg = decodeMessage(buf);
    if (!msg) return;

    const all = [...msg.answers, ...msg.authorities, ...msg.additionals];
    if (all.length === 0) return;

    const entry = byIp.get(rinfo.address) ?? {
      ip: rinfo.address,
      name: null,
      friendlyName: null,
      model: null,
      category: null,
      services: [],
      txt: {},
      ports: [],
    };

    for (const rr of all) {
      switch (rr.type) {
        case TYPE.PTR: {
          const target = typeof rr.data === 'string' ? rr.data : '';
          // rr.name is the service type; rr.data is the instance name.
          if (rr.name.startsWith('_') && !entry.services.includes(rr.name)) entry.services.push(rr.name);

          // A PTR answering the `_services._dns-sd._udp` meta-query points at
          // another *service type*, not an instance — using it as a name is how
          // a Hue bridge ends up called "_hue._tcp".
          if (target && !target.startsWith('_') && !entry.name) {
            entry.name = prettyInstance(target);
          }
          break;
        }
        case TYPE.SRV: {
          const srv = rr.data as { port?: number; target?: string } | undefined;
          if (srv?.port && !entry.ports.includes(srv.port)) entry.ports.push(srv.port);
          if (!entry.name && rr.name && !rr.name.startsWith('_')) entry.name = prettyInstance(rr.name);
          break;
        }
        case TYPE.TXT: {
          for (const kv of (rr.data as string[]) ?? []) {
            const eq = kv.indexOf('=');
            if (eq <= 0) continue;
            const key = kv.slice(0, eq);
            const value = kv.slice(eq + 1);
            if (!value || entry.txt[key]) continue;
            entry.txt[key] = value;

            // The device telling us its own name beats anything we can infer.
            if (!entry.friendlyName && NAME_KEYS.includes(key)) entry.friendlyName = value;
            if (!entry.model && MODEL_KEYS.includes(key)) entry.model = value;
            if (!entry.category && key === 'ci') entry.category = HOMEKIT_CATEGORIES[value] ?? null;
          }
          break;
        }
        case TYPE.A: {
          // An A record naming a .local host is the best hostname we will get.
          if (typeof rr.data === 'string' && rr.data === rinfo.address && rr.name) {
            entry.name = entry.name ?? rr.name.replace(/\.local$/, '');
          }
          break;
        }
        default:
          break;
      }
    }

    byIp.set(rinfo.address, entry);
  });

  await new Promise<void>((resolve) => socket.bind(MDNS_PORT, resolve));

  // Join the multicast group on each interface so we hear replies on all subnets.
  for (const addr of localAddresses) {
    try {
      socket.addMembership(MDNS_ADDR, addr);
    } catch (err) {
      log.debug(`addMembership failed on ${addr}: ${(err as Error).message}`);
    }
  }
  try {
    socket.setMulticastTTL(255);
  } catch {
    /* not fatal */
  }

  const query = encodeQuery(SERVICE_TYPES, TYPE.PTR);

  // Send twice — mDNS is lossy and some responders ignore the first probe.
  const send = () =>
    new Promise<void>((resolve) => {
      socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDR, () => resolve());
    });

  await send();
  setTimeout(() => void send().catch(() => {}), 900);

  await new Promise((r) => setTimeout(r, listenMs));

  for (const addr of localAddresses) {
    try {
      socket.dropMembership(MDNS_ADDR, addr);
    } catch {
      /* ignore */
    }
  }
  socket.close();

  const results = [...byIp.values()]
    .filter((r) => !localAddresses.includes(r.ip))
    // A name the owner chose always beats an instance name derived from a MAC.
    .map((r) => ({ ...r, name: r.friendlyName ?? r.name }));

  log.debug(`found ${results.length} mDNS responders`);
  return results;
}

/** "Living Room._sonos._tcp.local" -> "Living Room" */
function prettyInstance(fqdn: string): string {
  const first = fqdn.split(/\._[a-z-]+\._(tcp|udp)/i)[0] ?? fqdn;
  return first.replace(/\.local$/, '').replace(/\\032/g, ' ').trim() || fqdn;
}
