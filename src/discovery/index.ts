import dns from 'node:dns/promises';
import { CONFIG } from '../config.js';
import { logger } from '../logger.js';
import { pokeSubnet, readArpTable } from './arp.js';
import { discoverBroadlink } from './broadlink.js';
import { classify } from './classify.js';
import { discoverTuya } from './tuya.js';
import { discoverMdns } from './mdns.js';
import { discoverMiio, probeMiioBatch } from './miio.js';
import { activeInterfaces, broadcastForCidr, ipToInt, powershell } from './net.js';
import { lookupVendors } from './oui.js';
import { scanPortsBatch } from './ports.js';
import { discoverSsdp } from './ssdp.js';
import { scanWifiNetworks } from './wifi.js';
import type {
  DiscoveredDevice,
  DiscoverySource,
  NetworkInterfaceInfo,
  ScanOptions,
  ScanProgress,
  ScanResult,
} from './types.js';

const log = logger('discovery');

export type ProgressFn = (event: ScanProgress) => void;

/** Working record built up across the discovery stages before it becomes a device. */
interface Draft {
  ip: string;
  mac: string | null;
  hostname: string | null;
  openPorts: number[];
  sources: Set<DiscoverySource>;
  services: string[];
  evidence: Record<string, string | number | boolean>;
}

/**
 * Run a full network scan.
 *
 * Stages run in a deliberate order: the broadcast probes go first and in
 * parallel (they are all just waiting on a timeout), then the ARP table is read
 * once everything has been nudged, then the slower TCP fingerprinting pass runs
 * only against hosts we actually found.
 */
export async function scanNetwork(options: ScanOptions = {}, onProgress?: ProgressFn): Promise<ScanResult> {
  const startedAt = new Date();
  const emit = (e: ScanProgress) => {
    try {
      onProgress?.(e);
    } catch (err) {
      log.warn(`progress handler threw: ${(err as Error).message}`);
    }
  };

  const interfaces = await activeInterfaces();
  const subnets = options.subnets?.length
    ? options.subnets
    : interfaces.filter((i) => i.hostCount <= CONFIG.discovery.maxSubnetHosts).map((i) => i.cidr);

  const localAddresses = interfaces.map((i) => i.address);
  const gateways = await defaultGateways();

  emit({ phase: 'start', subnets, interfaces });
  log.info(`scanning ${subnets.join(', ')} across ${interfaces.length} interface(s)`);

  const drafts = new Map<string, Draft>();
  const draftFor = (ip: string): Draft => {
    let d = drafts.get(ip);
    if (!d) {
      d = { ip, mac: null, hostname: null, openPorts: [], sources: new Set(), services: [], evidence: {} };
      drafts.set(ip, d);
    }
    return d;
  };

  // --- Stage 1: broadcast probes + ARP nudge, all concurrently -------------
  emit({ phase: 'stage', stage: 'probe', message: 'Probing the network (mDNS, SSDP, miio, ARP)…' });

  const broadcasts = subnets.map(broadcastForCidr);
  const listenMs = CONFIG.discovery.listenMs;

  const primaryAddress = interfaces[0]?.address ?? '0.0.0.0';

  const [mdnsRecords, ssdpRecords, miioRecords, broadlinkRecords] = await Promise.all([
    discoverMdns(listenMs, localAddresses).catch((e) => {
      log.warn(`mDNS failed: ${e.message}`);
      return [];
    }),
    discoverSsdp(listenMs, localAddresses).catch((e) => {
      log.warn(`SSDP failed: ${e.message}`);
      return [];
    }),
    discoverMiio(listenMs, broadcasts).catch((e) => {
      log.warn(`miio failed: ${e.message}`);
      return [];
    }),
    discoverBroadlink(primaryAddress, broadcasts, listenMs).catch((e) => {
      log.warn(`Broadlink failed: ${e.message}`);
      return [];
    }),
    // The ARP sweep runs alongside the listeners; its results are read below.
    Promise.all(
      subnets.map((cidr) =>
        pokeSubnet(cidr, CONFIG.discovery.sweepConcurrency, CONFIG.discovery.maxSubnetHosts).catch((e) => {
          log.warn(`sweep of ${cidr} failed: ${e.message}`);
          return 0;
        }),
      ),
    ),
  ]);

  for (const r of mdnsRecords) {
    const d = draftFor(r.ip);
    d.sources.add('mdns');
    d.hostname ??= r.name;
    d.services.push(...r.services);
    for (const [k, v] of Object.entries(r.txt)) d.evidence[`txt.${k}`] = v;
    for (const p of r.ports) if (!d.openPorts.includes(p)) d.openPorts.push(p);
  }

  for (const r of ssdpRecords) {
    const d = draftFor(r.ip);
    d.sources.add('ssdp');
    d.hostname ??= r.friendlyName;
    if (r.server) d.evidence['ssdpServer'] = r.server;
    if (r.st) d.evidence['ssdpType'] = r.st;
    if (r.modelName) d.evidence['modelName'] = r.modelName;
    if (r.manufacturer) d.evidence['manufacturer'] = r.manufacturer;
    if (r.location) d.evidence['ssdpLocation'] = r.location;
  }

  const applyMiio = (r: { ip: string; deviceId: number; stamp: number; token: string | null }) => {
    const d = draftFor(r.ip);
    d.sources.add('miio');
    d.evidence['miioDeviceId'] = r.deviceId;
    d.evidence['miioUptimeSec'] = r.stamp;
    d.evidence['miioTokenExposed'] = r.token !== null;
    if (r.token) d.evidence['miioToken'] = r.token;
  };

  for (const r of miioRecords) applyMiio(r);

  for (const r of broadlinkRecords) {
    const d = draftFor(r.ip);
    d.sources.add('broadlink');
    d.mac ??= r.mac;
    d.hostname ??= r.name;
    d.evidence['broadlinkType'] = `0x${r.deviceType.toString(16)}`;
    if (r.model) d.evidence['broadlinkModel'] = r.model;
    d.evidence['broadlinkLocked'] = r.locked;
  }

  // --- Stage 2: read the neighbour table ---------------------------------
  emit({ phase: 'stage', stage: 'arp', message: 'Reading the ARP table…' });

  const inScope = subnetMatcher(subnets);
  for (const entry of await readArpTable()) {
    if (!inScope(entry.ip)) continue;
    const d = draftFor(entry.ip);
    d.mac = entry.mac;
    d.sources.add('arp');
    d.evidence['arpState'] = entry.state;
  }

  log.info(`${drafts.size} host(s) seen`);

  // --- Stage 2b: confirm miio by unicast ---------------------------------
  // The broadcast pass drops responders at random, so re-ask every host we now
  // know about individually. This is what actually pins down vacuums and other
  // Xiaomi-ecosystem gear.
  const unconfirmed = [...drafts.values()].filter((d) => !d.sources.has('miio')).map((d) => d.ip);
  if (unconfirmed.length > 0) {
    emit({ phase: 'stage', stage: 'miio', message: `Checking ${unconfirmed.length} host(s) for miio…` });
    for (const r of await probeMiioBatch(unconfirmed)) applyMiio(r);
  }

  // --- Stage 3: reverse DNS ----------------------------------------------
  emit({ phase: 'stage', stage: 'dns', message: 'Resolving hostnames…' });
  await Promise.all(
    [...drafts.values()].map(async (d) => {
      if (d.hostname) return;
      try {
        const names = await Promise.race([
          dns.reverse(d.ip),
          new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
        ]);
        if (names[0]) {
          d.hostname = names[0].replace(/\.(local|lan|home)$/i, '');
          d.sources.add('dns');
        }
      } catch {
        // No PTR record — very common on home networks.
      }
    }),
  );

  // --- Stage 4: TCP fingerprinting ---------------------------------------
  if (!options.skipPortScan && drafts.size > 0) {
    emit({ phase: 'stage', stage: 'ports', message: `Fingerprinting ${drafts.size} host(s)…` });
    const ips = [...drafts.keys()];
    await scanPortsBatch(ips, CONFIG.discovery.portTimeoutMs, CONFIG.discovery.portSocketBudget, (ip, ports) => {
      if (ports.length === 0) return;
      const d = draftFor(ip);
      d.sources.add('tcp');
      for (const p of ports) if (!d.openPorts.includes(p)) d.openPorts.push(p);
    });
  }

  // --- Stage 4b: confirm Magic Home controllers --------------------------
  // Port 5577 is a strong hint; the handshake makes it certain and tells us
  // the current colour and power state in the same round trip.
  const magicCandidates = [...drafts.values()].filter((d) => d.openPorts.includes(5577));
  if (magicCandidates.length > 0) {
    emit({ phase: 'stage', stage: 'magichome', message: `Checking ${magicCandidates.length} LED controller(s)…` });
    const { probeMagicHome } = await import('../drivers/magichome.js');
    await Promise.all(
      magicCandidates.map(async (d) => {
        const status = await probeMagicHome(d.ip);
        if (!status) return;
        d.evidence['magicHomeType'] = `0x${status.deviceType.toString(16)}`;
        d.evidence['magicHomePower'] = status.on ? 'on' : 'off';
        d.evidence['magicHomeColour'] = `rgb(${status.red},${status.green},${status.blue})`;
      }),
    );
  }

  // --- Stage 4c: optional Tuya listen ------------------------------------
  // Tuya devices announce themselves on their own schedule rather than on
  // request, so this only runs on a deep scan — it adds ~25s of pure waiting.
  if (options.deep) {
    emit({ phase: 'stage', stage: 'tuya', message: 'Listening for Tuya broadcasts (25s)…' });
    for (const r of await discoverTuya(25_000).catch(() => [])) {
      const d = draftFor(r.ip);
      d.sources.add('tuya');
      if (r.gwId) d.evidence['tuyaGwId'] = r.gwId;
      if (r.productKey) d.evidence['tuyaProductKey'] = r.productKey;
      if (r.version) d.evidence['tuyaVersion'] = r.version;
    }
  }

  // --- Stage 5: vendor lookup + classification ---------------------------
  emit({ phase: 'stage', stage: 'vendor', message: 'Identifying vendors…' });
  const vendorMap = await lookupVendors([...drafts.values()].map((d) => d.mac));

  const now = new Date().toISOString();
  const devices: DiscoveredDevice[] = [];

  for (const d of [...drafts.values()].sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip))) {
    const vendor = d.mac ? (vendorMap.get(d.mac) ?? null) : null;
    const gateway = gateways.find((g) => inScope(g)) ?? null;

    const { kind, confidence, suggestedDriver } = classify({
      ip: d.ip,
      vendor,
      hostname: d.hostname,
      openPorts: d.openPorts,
      services: d.services,
      evidence: d.evidence,
      gateway,
    });

    const device: DiscoveredDevice = {
      id: d.mac ?? `ip:${d.ip}`,
      ip: d.ip,
      mac: d.mac,
      vendor,
      hostname: d.hostname,
      openPorts: d.openPorts.sort((a, b) => a - b),
      sources: [...d.sources],
      evidence: d.evidence,
      kind,
      kindConfidence: confidence,
      suggestedDriver,
      adopted: false,
      firstSeen: now,
      lastSeen: now,
    };

    devices.push(device);
    emit({ phase: 'device', device });
  }

  // --- Stage 6: visible WiFi networks ------------------------------------
  let wifiNetworks: Awaited<ReturnType<typeof scanWifiNetworks>> = [];
  if (!options.skipWifi) {
    emit({ phase: 'stage', stage: 'wifi', message: 'Listing WiFi networks…' });
    wifiNetworks = await scanWifiNetworks().catch(() => []);
    emit({ phase: 'wifi', networks: wifiNetworks });
  }

  const finishedAt = new Date();
  const result: ScanResult = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    interfaces,
    subnetsScanned: subnets,
    devices,
    wifiNetworks,
  };

  log.info(`scan finished in ${result.durationMs}ms: ${devices.length} device(s)`);
  emit({ phase: 'done', result });
  return result;
}

/** Build a predicate that tests whether an IP falls inside any scanned subnet. */
function subnetMatcher(cidrs: string[]): (ip: string) => boolean {
  const ranges = cidrs.map((cidr) => {
    const [base, prefixRaw] = cidr.split('/');
    const prefix = Number(prefixRaw);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { network: (ipToInt(base!) & mask) >>> 0, mask };
  });

  return (ip: string) => {
    let n: number;
    try {
      n = ipToInt(ip);
    } catch {
      return false;
    }
    return ranges.some((r) => ((n & r.mask) >>> 0) === r.network);
  };
}

/** Default gateway addresses, used to flag the router in the results. */
async function defaultGateways(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const out = await powershell(
    'Get-NetRoute -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | ' +
      'Select-Object -ExpandProperty NextHop',
  );
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l) && l !== '0.0.0.0');
}

export type { NetworkInterfaceInfo, ScanResult, DiscoveredDevice };
