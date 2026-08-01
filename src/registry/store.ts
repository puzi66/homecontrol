import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { logger } from '../logger.js';
import type { DiscoveredDevice, ScanResult } from '../discovery/types.js';
import { displayNameFor } from '../discovery/classify.js';
import { knownDriverIds } from '../drivers/index.js';
import { stripBom } from './seen.js';
import { draftFromDiscovered, type AdoptRequest, type RegisteredDevice, type RegistryFile } from './types.js';

const log = logger('registry');

const EMPTY: RegistryFile = { version: 1, devices: [], rooms: [], lastScanAt: null };

/**
 * JSON-file registry of adopted devices.
 *
 * Small enough that we keep the whole thing in memory and rewrite it on change.
 * Writes go to a temp file and are renamed so a crash mid-write cannot leave a
 * truncated registry behind.
 */
export class DeviceRegistry {
  #state: RegistryFile = structuredClone(EMPTY);
  #loaded = false;
  #writeQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    if (this.#loaded) return;
    try {
      const raw = await fs.readFile(PATHS.devices, 'utf8');
      const parsed = JSON.parse(stripBom(raw)) as RegistryFile;
      if (parsed.version !== 1) throw new Error(`unsupported registry version ${parsed.version}`);
      this.#state = { ...structuredClone(EMPTY), ...parsed };
      log.info(`loaded ${this.#state.devices.length} device(s)`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') log.warn(`could not read registry, starting empty: ${e.message}`);
      this.#state = structuredClone(EMPTY);
    }
    this.#loaded = true;
  }

  /** Serialise writes so two concurrent requests cannot interleave. */
  #persist(): Promise<void> {
    this.#writeQueue = this.#writeQueue.then(async () => {
      await fs.mkdir(path.dirname(PATHS.devices), { recursive: true });
      const tmp = `${PATHS.devices}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.#state, null, 2), 'utf8');
      await fs.rename(tmp, PATHS.devices);
    });
    return this.#writeQueue;
  }

  list(): RegisteredDevice[] {
    return structuredClone(this.#state.devices);
  }

  get(id: string): RegisteredDevice | null {
    const found = this.#state.devices.find((d) => d.id === id);
    return found ? structuredClone(found) : null;
  }

  rooms(): string[] {
    return [...this.#state.rooms];
  }

  lastScanAt(): string | null {
    return this.#state.lastScanAt;
  }

  /** Adopt a device, or update it in place if it is already registered. */
  async adopt(req: AdoptRequest, discovered?: DiscoveredDevice): Promise<RegisteredDevice> {
    const proposed = req.id ?? discovered?.id ?? (req.mac ? req.mac.toLowerCase() : `ip:${req.ip}`);
    const mac = (req.mac ?? discovered?.mac)?.toLowerCase() ?? null;

    // Match an existing entry before minting a new id. The same device adopted
    // once before its MAC was known and again afterwards would otherwise become
    // two registrations of one thing — one keyed `ip:x`, one keyed by MAC.
    const already = this.#state.devices.find(
      (d) =>
        d.id === proposed ||
        (mac !== null && d.mac?.toLowerCase() === mac) ||
        (d.ip === req.ip && (d.id.startsWith('ip:') || proposed.startsWith('ip:'))),
    );

    const id = already?.id ?? proposed;
    const now = new Date().toISOString();

    const existingIndex = this.#state.devices.findIndex((d) => d.id === id);
    const base: RegisteredDevice =
      existingIndex >= 0
        ? this.#state.devices[existingIndex]!
        : discovered
          ? { ...draftFromDiscovered(discovered, req.name), adoptedAt: now, updatedAt: now }
          : {
              id,
              name: req.name,
              kind: req.kind ?? 'unknown',
              room: null,
              ip: req.ip,
              mac: req.mac ?? null,
              vendor: null,
              hostname: null,
              driver: null,
              driverConfig: {},
              enabled: true,
              notes: null,
              discovery: { openPorts: [], evidence: {}, sources: ['manual'] },
              adoptedAt: now,
              updatedAt: now,
              lastSeen: null,
              online: false,
            };

    const device: RegisteredDevice = {
      ...base,
      id,
      name: req.name || base.name,
      ip: req.ip || base.ip,
      mac: req.mac ?? base.mac,
      kind: req.kind ?? base.kind,
      room: req.room !== undefined ? req.room : base.room,
      driver: req.driver !== undefined ? req.driver : base.driver,
      driverConfig: req.driverConfig ? { ...base.driverConfig, ...req.driverConfig } : base.driverConfig,
      notes: req.notes !== undefined ? req.notes : base.notes,
      updatedAt: now,
    };

    if (existingIndex >= 0) this.#state.devices[existingIndex] = device;
    else this.#state.devices.push(device);

    if (device.room && !this.#state.rooms.includes(device.room)) this.#state.rooms.push(device.room);

    await this.#persist();
    log.info(`adopted ${device.name} (${device.id})`);
    return structuredClone(device);
  }

  async update(id: string, patch: Partial<RegisteredDevice>): Promise<RegisteredDevice | null> {
    const index = this.#state.devices.findIndex((d) => d.id === id);
    if (index < 0) return null;

    // id and adoptedAt are identity, never patchable.
    const { id: _ignoredId, adoptedAt: _ignoredAdopted, ...safe } = patch;
    const updated: RegisteredDevice = {
      ...this.#state.devices[index]!,
      ...safe,
      updatedAt: new Date().toISOString(),
    };
    this.#state.devices[index] = updated;

    if (updated.room && !this.#state.rooms.includes(updated.room)) this.#state.rooms.push(updated.room);

    await this.#persist();
    return structuredClone(updated);
  }

  async remove(id: string): Promise<boolean> {
    const before = this.#state.devices.length;
    this.#state.devices = this.#state.devices.filter((d) => d.id !== id);
    if (this.#state.devices.length === before) return false;
    await this.#persist();
    log.info(`removed ${id}`);
    return true;
  }

  async addRoom(name: string): Promise<string[]> {
    const trimmed = name.trim();
    if (trimmed && !this.#state.rooms.includes(trimmed)) {
      this.#state.rooms.push(trimmed);
      await this.#persist();
    }
    return [...this.#state.rooms];
  }

  /**
   * Fold a scan result into the registry: refresh IP/vendor/online for adopted
   * devices, and mark anything the scan did not see as offline.
   */
  async reconcile(scan: ScanResult): Promise<void> {
    const byId = new Map(scan.devices.map((d) => [d.id, d]));
    const now = new Date().toISOString();

    let adopted = 0;

    for (const device of this.#state.devices) {
      const seen = byId.get(device.id);
      if (seen) {
        device.ip = seen.ip;
        device.vendor = seen.vendor ?? device.vendor;
        device.hostname = seen.hostname ?? device.hostname;
        device.discovery = { openPorts: seen.openPorts, evidence: seen.evidence, sources: seen.sources };
        device.lastSeen = now;
        device.online = true;

        // Discovery already worked out how to talk to this thing. Making someone
        // pick the driver by hand when the scan knows the answer is a chore with
        // no decision in it — and devices adopted before a driver existed would
        // otherwise stay inert forever.
        // Only assign something that exists. Discovery names protocols it can
        // recognise but that nothing here implements yet, and auto-assigning
        // one of those would leave the device permanently erroring instead of
        // simply unconfigured.
        if (!device.driver && seen.suggestedDriver && knownDriverIds.has(seen.suggestedDriver)) {
          device.driver = seen.suggestedDriver;
          device.updatedAt = now;
          adopted += 1;
          log.info(`assigned the ${seen.suggestedDriver} driver to ${device.name}`);
        }
      } else {
        device.online = false;
      }
    }

    if (adopted > 0) log.info(`auto-assigned ${adopted} driver(s) from the scan`);

    await this.#healDuplicates(scan);

    this.#state.lastScanAt = scan.finishedAt;
    await this.#persist();
  }

  /**
   * Collapse entries that turned out to be the same device.
   *
   * A device adopted before any scan knew its MAC gets keyed `ip:x`. Once a
   * sweep supplies the MAC it should move to that stable identity — and if a
   * MAC-keyed entry already exists, the two are one device and must be merged
   * rather than left side by side. The MAC survives because an address moves
   * and a MAC does not.
   */
  async #healDuplicates(scan: ScanResult): Promise<void> {
    const macByIp = new Map(scan.devices.filter((d) => d.mac).map((d) => [d.ip, d.mac!.toLowerCase()]));
    let merged = 0;

    for (const stale of this.#state.devices.filter((d) => d.id.startsWith('ip:'))) {
      const mac = macByIp.get(stale.ip);
      if (!mac) continue;

      const twin = this.#state.devices.find((d) => d.id !== stale.id && d.mac?.toLowerCase() === mac);

      if (twin) {
        // Keep whichever side was actually configured; a driver with settings
        // took someone effort, an empty one did not.
        const configured = Object.keys(stale.driverConfig).length > 0 ? stale : twin;
        const other = configured === stale ? twin : stale;

        twin.name = configured.name;
        twin.room = configured.room ?? other.room;
        twin.driver = configured.driver ?? other.driver;
        twin.driverConfig = { ...other.driverConfig, ...configured.driverConfig };
        twin.notes = configured.notes ?? other.notes;
        twin.kind = configured.kind !== 'unknown' ? configured.kind : other.kind;
        twin.updatedAt = new Date().toISOString();

        this.#state.devices = this.#state.devices.filter((d) => d.id !== stale.id);
        log.info(`merged duplicate registrations for ${twin.name} (${stale.id} into ${twin.id})`);
      } else {
        stale.id = mac;
        stale.mac = mac;
        log.info(`re-keyed ${stale.name} from an address to its MAC`);
      }
      merged += 1;
    }

    if (merged > 0) log.info(`resolved ${merged} duplicate or address-keyed registration(s)`);
  }

  /** Tag scan results with whether we already know about each device. */
  annotate(devices: DiscoveredDevice[]): DiscoveredDevice[] {
    const known = new Set(this.#state.devices.map((d) => d.id));
    return devices.map((d) => ({ ...d, adopted: known.has(d.id) }));
  }

  /** Name we would suggest in the adopt dialog. */
  suggestName(d: DiscoveredDevice): string {
    return displayNameFor(d);
  }
}

export const registry = new DeviceRegistry();
