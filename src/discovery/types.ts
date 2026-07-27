/** Every distinct way we can learn that something exists on the network. */
export type DiscoverySource =
  | 'arp'        // reachable in the ARP/neighbour table
  | 'mdns'       // answered a multicast DNS query
  | 'ssdp'       // answered an SSDP/UPnP M-SEARCH
  | 'miio'       // answered the Xiaomi/Dreame miio handshake
  | 'broadlink'  // answered the Broadlink discovery probe
  | 'tuya'       // broadcast a Tuya announcement
  | 'tcp'        // had at least one open TCP port
  | 'dns'        // resolved to a hostname
  | 'manual';    // typed in by the user

/**
 * A device as observed on the network, before the user decides to adopt it.
 * Keyed by MAC when we have one, otherwise by IP.
 */
export interface DiscoveredDevice {
  /** Stable identity: normalised MAC (`aa:bb:cc:dd:ee:ff`) or `ip:<address>`. */
  id: string;
  ip: string;
  mac: string | null;
  /** OUI vendor, e.g. "Philips Lighting BV". */
  vendor: string | null;
  /** Best available human name: mDNS name, SSDP friendlyName or reverse DNS. */
  hostname: string | null;
  /** Open TCP ports found during fingerprinting. */
  openPorts: number[];
  /** Which probes saw this device. */
  sources: DiscoverySource[];
  /** Protocol-specific findings, e.g. miio device id, SSDP model name. */
  evidence: Record<string, string | number | boolean>;
  /** Inferred category + how sure we are. */
  kind: DeviceKind;
  kindConfidence: 'high' | 'medium' | 'low';
  /** Driver we think can control it, if any. */
  suggestedDriver: string | null;
  /** True when this device is already in the registry. */
  adopted: boolean;
  firstSeen: string;
  lastSeen: string;
}

export type DeviceKind =
  | 'router'
  | 'vacuum'
  | 'light'
  | 'speaker'
  | 'tv'
  | 'media'
  | 'camera'
  | 'sensor'
  | 'plug'
  | 'thermostat'
  | 'printer'
  | 'computer'
  | 'phone'
  | 'nas'
  | 'hub'
  | 'iot'
  | 'unknown';

/** A WiFi network visible from this machine (not necessarily joined). */
export interface WifiNetwork {
  ssid: string;
  bssid: string | null;
  signal: number | null;
  channel: number | null;
  band: string | null;
  authentication: string | null;
  encryption: string | null;
  /** True for the SSID this machine is currently associated with. */
  connected: boolean;
}

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  netmask: string;
  cidr: string;
  /** Number of usable host addresses in this subnet. */
  hostCount: number;
  /** WiFi vs wired, when we can tell. */
  media: 'wifi' | 'wired' | 'unknown';
}

export interface ScanOptions {
  /** Restrict the sweep to these CIDRs. Defaults to every active adapter's subnet. */
  subnets?: string[];
  /** Skip the (slower) TCP port fingerprinting pass. */
  skipPortScan?: boolean;
  /** Skip enumerating visible WiFi networks. */
  skipWifi?: boolean;
  /**
   * Run the slow passive passes too — currently the 25-second Tuya listen.
   * Tuya devices only announce on their own schedule, so this is the difference
   * between "has port 6668 open" and knowing the device id and product key.
   */
  deep?: boolean;
}

export interface ScanResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  interfaces: NetworkInterfaceInfo[];
  subnetsScanned: string[];
  devices: DiscoveredDevice[];
  wifiNetworks: WifiNetwork[];
}

/** Progress events streamed to the dashboard over WebSocket during a scan. */
export type ScanProgress =
  | { phase: 'start'; subnets: string[]; interfaces: NetworkInterfaceInfo[] }
  | { phase: 'stage'; stage: string; message: string }
  | { phase: 'device'; device: DiscoveredDevice }
  | { phase: 'wifi'; networks: WifiNetwork[] }
  | { phase: 'done'; result: ScanResult }
  | { phase: 'error'; message: string };
