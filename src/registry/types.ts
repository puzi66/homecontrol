import type { DeviceKind, DiscoveredDevice } from '../discovery/types.js';

/** A device the user has explicitly adopted into the system. */
export interface RegisteredDevice {
  /** Same identity as DiscoveredDevice.id — MAC when known, else `ip:<addr>`. */
  id: string;
  /** User-chosen name. Defaults to whatever discovery inferred. */
  name: string;
  kind: DeviceKind;
  room: string | null;
  /** Last known address. Refreshed on every scan, since DHCP leases move. */
  ip: string;
  mac: string | null;
  vendor: string | null;
  hostname: string | null;
  /** Driver used to control it, e.g. "hue" | "sonos" | "mova". Null = monitor only. */
  driver: string | null;
  /** Free-form per-driver settings (bridge username, miio token, room map…). */
  driverConfig: Record<string, unknown>;
  /** Whether the device should appear on the dashboard. */
  enabled: boolean;
  notes: string | null;
  /** Everything discovery knew at adoption time, kept for debugging. */
  discovery: {
    openPorts: number[];
    evidence: Record<string, string | number | boolean>;
    sources: string[];
  };
  adoptedAt: string;
  updatedAt: string;
  lastSeen: string | null;
  /** True when the most recent scan found it. */
  online: boolean;
}

export interface RegistryFile {
  version: 1;
  devices: RegisteredDevice[];
  rooms: string[];
  /** ISO timestamp of the last completed scan. */
  lastScanAt: string | null;
}

export interface AdoptRequest {
  /** Device id from a scan result, or omitted when adding manually by IP. */
  id?: string;
  ip: string;
  mac?: string | null;
  name: string;
  kind?: DeviceKind;
  room?: string | null;
  driver?: string | null;
  driverConfig?: Record<string, unknown>;
  notes?: string | null;
}

export function draftFromDiscovered(d: DiscoveredDevice, name: string): Omit<RegisteredDevice, 'adoptedAt' | 'updatedAt'> {
  return {
    id: d.id,
    name,
    kind: d.kind,
    room: null,
    ip: d.ip,
    mac: d.mac,
    vendor: d.vendor,
    hostname: d.hostname,
    driver: d.suggestedDriver,
    driverConfig: {},
    enabled: true,
    notes: null,
    discovery: { openPorts: d.openPorts, evidence: d.evidence, sources: d.sources },
    lastSeen: d.lastSeen,
    online: true,
  };
}
