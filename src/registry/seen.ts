import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { logger } from '../logger.js';
import type { DhcpSighting } from '../discovery/dhcp.js';
import type { DeviceKind, DiscoveredDevice, ScanResult } from '../discovery/types.js';

const log = logger('seen');

const FILE = path.join(PATHS.data, 'seen.json');

/**
 * A device the network has shown us at least once, adopted or not.
 *
 * Separate from the device registry on purpose: the registry holds the handful
 * of things you chose to control, this holds everything that has ever appeared.
 */
export interface SeenDevice {
  id: string;
  ip: string;
  mac: string | null;
  vendor: string | null;
  hostname: string | null;
  kind: DeviceKind;
  kindConfidence: 'high' | 'medium' | 'low';
  suggestedDriver: string | null;
  openPorts: number[];
  sources: string[];
  evidence: Record<string, string | number | boolean>;
  firstSeenAt: string;
  lastSeenAt: string;
  /** How many scans have found it. */
  scanCount: number;
  /** True when the most recent scan saw it. */
  present: boolean;
  /** Previous addresses, newest first. DHCP moves things around. */
  previousIps: string[];
}

interface SeenFile {
  version: 1;
  devices: SeenDevice[];
  lastScanAt: string | null;
  /**
   * DHCP sightings for MACs no scan has found yet. A device can announce itself
   * before it ever appears in a sweep, and throwing that away would mean
   * waiting for it to renew its lease again — which can be an hour.
   */
  pendingDhcp?: Record<string, DhcpSighting>;
}

const EMPTY: SeenFile = { version: 1, devices: [], lastScanAt: null, pendingDhcp: {} };

/** Rank kinds so a later, vaguer guess cannot overwrite a confident one. */
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

/**
 * Drop a leading byte-order mark.
 *
 * JSON.parse rejects a BOM outright, and plenty of editors add one when saving
 * UTF-8 — PowerShell's Set-Content among them. Losing the whole ledger to an
 * invisible character because someone opened the file is not a good trade.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The ledger of everything ever seen on the network.
 *
 * The point is accumulation. A scan is a snapshot and snapshots are lossy — a
 * device that answered mDNS last week may be asleep today, and a sweep that
 * misses it should not erase what we learned. So a merge keeps the better of
 * the old and new value for every field rather than overwriting wholesale.
 */
export class SeenLedger {
  #devices = new Map<string, SeenDevice>();
  #lastScanAt: string | null = null;
  #pendingDhcp = new Map<string, DhcpSighting>();
  #loaded = false;
  #writeQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    if (this.#loaded) return;
    try {
      const raw = await fs.readFile(FILE, 'utf8');
      const parsed = JSON.parse(stripBom(raw)) as SeenFile;
      if (parsed.version !== 1) throw new Error(`unsupported version ${parsed.version}`);
      this.#devices = new Map(parsed.devices.map((d) => [d.id, d]));
      this.#lastScanAt = parsed.lastScanAt;
      this.#pendingDhcp = new Map(Object.entries(parsed.pendingDhcp ?? {}));
      log.info(`loaded ${this.#devices.size} previously seen device(s)`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') log.warn(`could not read the ledger, starting empty: ${e.message}`);
    }
    this.#loaded = true;
  }

  #persist(): Promise<void> {
    this.#writeQueue = this.#writeQueue.then(async () => {
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      const body: SeenFile = {
        version: 1,
        devices: [...this.#devices.values()],
        lastScanAt: this.#lastScanAt,
        pendingDhcp: Object.fromEntries(this.#pendingDhcp),
      };
      const tmp = `${FILE}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
      await fs.rename(tmp, FILE);
    });
    return this.#writeQueue;
  }

  list(): SeenDevice[] {
    return structuredClone([...this.#devices.values()]);
  }

  get(id: string): SeenDevice | null {
    const found = this.#devices.get(id);
    return found ? structuredClone(found) : null;
  }

  lastScanAt(): string | null {
    return this.#lastScanAt;
  }

  /**
   * Fold a scan into the ledger.
   *
   * Fields are merged rather than replaced: a null hostname in this scan does
   * not erase a hostname learned in an earlier one, and a device classified
   * `unknown` today keeps a confident classification from before. Evidence is
   * unioned, because different passes learn different things and a scan where
   * the device happened to be quiet should not lose the rest.
   */
  async merge(scan: ScanResult): Promise<void> {
    const now = scan.finishedAt;
    const seenThisScan = new Set<string>();

    for (const device of scan.devices) {
      seenThisScan.add(device.id);
      const existing = this.#devices.get(device.id);

      if (!existing) {
        this.#devices.set(device.id, {
          id: device.id,
          ip: device.ip,
          mac: device.mac,
          vendor: device.vendor,
          hostname: device.hostname,
          kind: device.kind,
          kindConfidence: device.kindConfidence,
          suggestedDriver: device.suggestedDriver,
          openPorts: device.openPorts,
          sources: device.sources,
          evidence: device.evidence,
          firstSeenAt: now,
          lastSeenAt: now,
          scanCount: 1,
          present: true,
          previousIps: [],
        });
        continue;
      }

      // The address moved: remember where it used to be.
      const previousIps =
        device.ip !== existing.ip
          ? [existing.ip, ...existing.previousIps.filter((ip) => ip !== device.ip)].slice(0, 5)
          : existing.previousIps;

      const betterKind =
        CONFIDENCE_RANK[device.kindConfidence] >= CONFIDENCE_RANK[existing.kindConfidence] &&
        device.kind !== 'unknown';

      this.#devices.set(device.id, {
        ...existing,
        ip: device.ip,
        previousIps,
        mac: device.mac ?? existing.mac,
        vendor: device.vendor ?? existing.vendor,
        hostname: device.hostname ?? existing.hostname,
        kind: betterKind ? device.kind : existing.kind,
        kindConfidence: betterKind ? device.kindConfidence : existing.kindConfidence,
        suggestedDriver: device.suggestedDriver ?? existing.suggestedDriver,
        // An empty port list usually means the scan was unlucky, not that the
        // device closed everything.
        openPorts: device.openPorts.length > 0 ? device.openPorts : existing.openPorts,
        sources: [...new Set([...existing.sources, ...device.sources])],
        evidence: { ...existing.evidence, ...device.evidence },
        lastSeenAt: now,
        scanCount: existing.scanCount + 1,
        present: true,
      });
    }

    // Everything else is still remembered, just not currently answering.
    for (const [id, device] of this.#devices) {
      if (!seenThisScan.has(id)) this.#devices.set(id, { ...device, present: false });
    }

    // Apply any DHCP sighting that arrived before a scan had met the device.
    for (const [mac, sighting] of this.#pendingDhcp) {
      const match = [...this.#devices.values()].find((d) => d.mac === mac);
      if (!match) continue;
      this.#devices.set(match.id, this.#applyDhcp(match, sighting));
      this.#pendingDhcp.delete(mac);
      log.info(`matched a held DHCP sighting to ${match.ip}: ${sighting.hostname ?? mac}`);
    }

    this.#lastScanAt = now;
    await this.#persist();
    log.info(`ledger holds ${this.#devices.size} device(s), ${seenThisScan.size} present`);
  }

  /**
   * Fold in what a device said about itself over DHCP.
   *
   * A self-declared hostname outranks anything discovery inferred, so it wins
   * when the device has not otherwise named itself. If no scan has met this MAC
   * yet the sighting is held, and `merge` applies it the moment one does.
   */
  async noteDhcp(sighting: DhcpSighting): Promise<boolean> {
    const match = [...this.#devices.values()].find((d) => d.mac === sighting.mac);

    if (!match) {
      this.#pendingDhcp.set(sighting.mac, sighting);
      await this.#persist();
      return false;
    }

    this.#devices.set(match.id, this.#applyDhcp(match, sighting));
    await this.#persist();
    log.info(`${sighting.mac} named itself "${sighting.hostname ?? sighting.vendorClass}"`);
    return true;
  }

  #applyDhcp(device: SeenDevice, sighting: DhcpSighting): SeenDevice {
    const evidence = { ...device.evidence };
    if (sighting.hostname) evidence['dhcpHostname'] = sighting.hostname;
    if (sighting.vendorClass) evidence['dhcpVendorClass'] = sighting.vendorClass;
    if (sighting.paramList) evidence['dhcpParamList'] = sighting.paramList;

    return {
      ...device,
      // Only fill a blank. A name from mDNS or SSDP was chosen by a person;
      // the DHCP hostname is usually firmware default.
      hostname: device.hostname ?? sighting.hostname,
      sources: [...new Set([...device.sources, 'dhcp'])],
      evidence,
    };
  }

  async forget(id: string): Promise<boolean> {
    if (!this.#devices.delete(id)) return false;
    await this.#persist();
    return true;
  }

  async clear(): Promise<void> {
    this.#devices.clear();
    await this.#persist();
  }

  /**
   * The ledger rendered as scan results, so the dashboard can show remembered
   * devices before any scan has run in this process.
   */
  asDiscovered(adopted: Set<string>): DiscoveredDevice[] {
    return [...this.#devices.values()].map((d) => ({
      id: d.id,
      ip: d.ip,
      mac: d.mac,
      vendor: d.vendor,
      hostname: d.hostname,
      openPorts: d.openPorts,
      sources: d.sources as DiscoveredDevice['sources'],
      evidence: d.evidence,
      kind: d.kind,
      kindConfidence: d.kindConfidence,
      suggestedDriver: d.suggestedDriver,
      adopted: adopted.has(d.id),
      present: d.present,
      firstSeen: d.firstSeenAt,
      lastSeen: d.lastSeenAt,
    }));
  }
}

export const seen = new SeenLedger();
