import type { DeviceKind, DiscoveredDevice } from './types.js';

export interface ClassifyInput {
  ip: string;
  vendor: string | null;
  hostname: string | null;
  openPorts: number[];
  services: string[];
  evidence: Record<string, string | number | boolean>;
  /** Default gateway address for the subnet, if known. */
  gateway?: string | null;
}

export interface Classification {
  kind: DeviceKind;
  confidence: 'high' | 'medium' | 'low';
  suggestedDriver: string | null;
}

/**
 * Infer what a device is from everything we observed.
 *
 * Rules are ordered most-specific first and the first match wins, so a Sonos
 * speaker is classified by its mDNS service rather than falling through to the
 * generic "has port 80 open" rule.
 */
export function classify(input: ClassifyInput): Classification {
  const vendor = (input.vendor ?? '').toLowerCase();
  const host = (input.hostname ?? '').toLowerCase();
  const services = input.services.map((s) => s.toLowerCase());
  const ports = new Set(input.openPorts);
  const ev = input.evidence;

  const hasService = (needle: string) => services.some((s) => s.includes(needle));

  // Everything a device has said about itself, in one haystack: SSDP model,
  // mDNS TXT model, and whatever its web interface put in the title or the
  // Server header. Matching across all of them beats guessing from a MAC.
  const model = [
    ev['modelName'], ev['ssdpServer'], ev['httpTitle'], ev['httpServer'], ev['httpRedirect'],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // --- This machine ------------------------------------------------------
  // No inference needed: it is the host running all of this.
  if (ev['isThisMachine'] === true) {
    return { kind: 'computer', confidence: 'high', suggestedDriver: null };
  }

  // --- Gateway -----------------------------------------------------------
  // The one device that genuinely is the router.
  if (input.gateway && input.ip === input.gateway) {
    return { kind: 'router', confidence: 'high', suggestedDriver: null };
  }

  // --- The device saying what it is --------------------------------------
  // A HomeKit accessory publishes its own category. Nothing we could infer
  // from a MAC prefix or an open port comes close, so this goes first.
  const homekit = String(ev['homekitCategory'] ?? '');
  if (homekit) {
    const byCategory: Record<string, DeviceKind> = {
      lightbulb: 'light', outlet: 'plug', switch: 'plug', thermostat: 'thermostat',
      sensor: 'sensor', camera: 'camera', 'video doorbell': 'camera', bridge: 'hub',
      television: 'tv', 'tv set-top box': 'tv', 'tv stick': 'media', 'audio receiver': 'speaker',
      fan: 'iot', 'air conditioner': 'thermostat', heater: 'thermostat',
      'window covering': 'iot', 'door lock': 'iot', 'garage door': 'iot',
      'security system': 'sensor', router: 'router', 'range extender': 'router',
    };
    const mapped = byCategory[homekit];
    if (mapped) return { kind: mapped, confidence: 'high', suggestedDriver: null };
  }

  // --- What the device called itself -------------------------------------
  // A hostname the firmware chose is weaker than a HomeKit category but far
  // stronger than a MAC prefix: a name like "<brand>_vacuum_<model>" settles in
  // one field a question no amount of port scanning could answer. DHCP is
  // usually where these come from.
  const declared = `${host} ${String(ev['dhcpHostname'] ?? '')} ${String(ev['dhcpVendorClass'] ?? '')}`.toLowerCase();
  const byName: [RegExp, DeviceKind][] = [
    [/vacuum|robot|roborock|sweeper/, 'vacuum'],
    [/\bcam\b|camera|ipc[-_]|doorbell/, 'camera'],
    [/\btv\b|televis|chromecast|firestick|shield/, 'tv'],
    [/speaker|soundbar|audio/, 'speaker'],
    [/bulb|lamp|light|dimmer/, 'light'],
    [/plug|socket|plugin|outlet/, 'plug'],
    [/sensor|motion|\bpir\b|thermo/, 'sensor'],
    [/printer/, 'printer'],
  ];
  for (const [pattern, kind] of byName) {
    if (!pattern.test(declared)) continue;
    // Naming itself settles *what* it is; the protocols it speaks still decide
    // how to talk to it. A vacuum answering miio is still driveable.
    const driver =
      kind === 'vacuum' && ev['miioDeviceId'] !== undefined
        ? 'mova'
        : kind === 'light' && ports.has(5577)
          ? 'magichome'
          : ports.has(6668)
            ? 'tuya'
            : null;
    return { kind, confidence: 'high', suggestedDriver: driver };
  }

  // --- Robot vacuums -----------------------------------------------------
  // Only brands that exclusively make vacuums count here. AltoBeam used to be
  // on this list, which was a mistake: it is a WiFi chip vendor, and its
  // silicon turns up in cameras and speakers as readily as in robots. A chip
  // maker says who built the radio, not what the product is — this rule
  // confidently mislabelled a camera as a vacuum for some time.
  const speaksMiio = ev['miioDeviceId'] !== undefined;
  if (speaksMiio) {
    const vacuumBrand =
      vendor.includes('dreame') ||
      vendor.includes('roborock') ||
      host.includes('vacuum') ||
      host.includes('mova');
    if (vacuumBrand) return { kind: 'vacuum', confidence: 'high', suggestedDriver: 'mova' };
  }

  // --- Lighting ----------------------------------------------------------
  if (vendor.includes('philips lighting') || hasService('_hue') || model.includes('hue bridge')) {
    return { kind: 'hub', confidence: 'high', suggestedDriver: 'hue' };
  }
  if (vendor.includes('lifx') || vendor.includes('nanoleaf')) {
    return { kind: 'light', confidence: 'medium', suggestedDriver: null };
  }
  // Port 5577 is the Magic Home / LEDENET LED controller, used by most no-name
  // RGB strip and bulb controllers. Confirmed by handshake in the probe below.
  if (ports.has(5577) || ev['magicHomeType'] !== undefined) {
    return { kind: 'light', confidence: 'high', suggestedDriver: 'magichome' };
  }

  // --- Switcher ----------------------------------------------------------
  // The broadcast is unambiguous: nothing else speaks it.
  if (ev['switcherDeviceId'] !== undefined) {
    const family = String(ev['switcherFamily'] ?? '');
    // Breeze is an AC controller and Runner is a shutter; neither is a plug,
    // and neither speaks the Type 1 control API this driver implements.
    if (family === 'breeze/runner') return { kind: 'iot', confidence: 'high', suggestedDriver: null };
    return { kind: 'plug', confidence: 'high', suggestedDriver: 'switcher' };
  }

  // --- IR blasters -------------------------------------------------------
  if (ev['broadlinkType'] !== undefined || vendor.includes('broadlink')) {
    const model = String(ev['broadlinkModel'] ?? '').toLowerCase();
    if (model.includes('plug') || model.includes('sp')) {
      return { kind: 'plug', confidence: 'high', suggestedDriver: null };
    }
    if (model.includes('sensor')) return { kind: 'sensor', confidence: 'high', suggestedDriver: null };
    return { kind: 'iot', confidence: 'high', suggestedDriver: null };
  }

  // --- Tuya --------------------------------------------------------------
  // 6668 is Tuya's local control port. Control needs a per-device local key from
  // the Tuya cloud, which tuya-keys fetches — so the driver is worth suggesting.
  if (ports.has(6668) || ev['tuyaGwId'] !== undefined) {
    return { kind: 'iot', confidence: 'high', suggestedDriver: 'tuya' };
  }

  // --- Audio -------------------------------------------------------------
  if (vendor.includes('sonos') || hasService('_sonos') || ports.has(1400) || model.includes('sonos')) {
    return { kind: 'speaker', confidence: 'high', suggestedDriver: 'sonos' };
  }
  if (hasService('_spotify-connect') || hasService('_raop')) {
    return { kind: 'speaker', confidence: 'medium', suggestedDriver: null };
  }

  // --- Casting / TV ------------------------------------------------------
  if (hasService('_googlecast') || ports.has(8008) || ports.has(8009)) {
    const isTv = model.includes('tv') || host.includes('tv') || model.includes('shield');
    return { kind: isTv ? 'tv' : 'media', confidence: 'high', suggestedDriver: 'cast' };
  }
  if (vendor.includes('samsung') && (ports.has(8001) || ports.has(8080) || model.includes('tv'))) {
    return { kind: 'tv', confidence: 'medium', suggestedDriver: null };
  }
  if (vendor.includes('nvidia')) {
    // Shield TV casts; a Jetson dev board does not.
    const shield = hasService('_googlecast') || model.includes('shield');
    return shield
      ? { kind: 'tv', confidence: 'medium', suggestedDriver: 'cast' }
      : { kind: 'computer', confidence: 'medium', suggestedDriver: null };
  }
  if (ports.has(32400)) return { kind: 'media', confidence: 'high', suggestedDriver: null };

  // --- Home automation hubs ---------------------------------------------
  if (ports.has(8123) || hasService('_homeassistant')) {
    return { kind: 'hub', confidence: 'high', suggestedDriver: null };
  }
  if (hasService('_esphomelib') || ports.has(6053)) {
    return { kind: 'iot', confidence: 'high', suggestedDriver: null };
  }
  if (hasService('_matter')) return { kind: 'iot', confidence: 'medium', suggestedDriver: null };
  if (hasService('_hap')) return { kind: 'iot', confidence: 'medium', suggestedDriver: null };
  if (ports.has(1883)) return { kind: 'hub', confidence: 'medium', suggestedDriver: null };

  // --- Cameras -----------------------------------------------------------
  if (ports.has(554) || host.includes('cam') || model.includes('camera')) {
    return { kind: 'camera', confidence: 'medium', suggestedDriver: null };
  }

  // --- Printers ----------------------------------------------------------
  // Port 631 is CUPS, the printing *service* — every Linux desktop runs it. A
  // host with SSH open is a computer that can print, not a printer, and calling
  // it one is how a workstation ends up filed under hardware it merely talks to.
  const printerPorts = ports.has(631) || ports.has(9100);
  const looksLikeAComputer = ports.has(22) || ports.has(445) || ports.has(3389);

  if ((printerPorts && !looksLikeAComputer) || hasService('_printer') || hasService('_ipp')) {
    return { kind: 'printer', confidence: 'high', suggestedDriver: null };
  }
  if (printerPorts && looksLikeAComputer) {
    return { kind: 'computer', confidence: 'medium', suggestedDriver: null };
  }

  // --- Storage -----------------------------------------------------------
  if (vendor.includes('synology') || vendor.includes('qnap') || (ports.has(445) && ports.has(5000))) {
    return { kind: 'nas', confidence: 'medium', suggestedDriver: null };
  }

  // --- Anything else in the Xiaomi ecosystem -----------------------------
  // Reached only when the more specific rules above did not claim the device.
  if (speaksMiio) return { kind: 'iot', confidence: 'medium', suggestedDriver: 'miio' };

  // --- Generic IoT silicon ----------------------------------------------
  // These vendors only ever appear inside smart devices, never in a PC.
  const iotSilicon = ['espressif', 'tuya', 'shelly', 'altobeam', 'lumi united', 'realtek semiconductor'];
  if (iotSilicon.some((v) => vendor.includes(v))) {
    return { kind: 'iot', confidence: 'medium', suggestedDriver: null };
  }
  if (vendor.includes('azurewave') || vendor.includes('fn-link') || vendor.includes('hunan')) {
    // WiFi module makers — the device is smart, but we cannot tell what it is.
    return { kind: 'iot', confidence: 'low', suggestedDriver: null };
  }

  // --- Computers and phones ---------------------------------------------
  if (ports.has(445) || ports.has(3389) || hasService('_smb') || hasService('_workstation')) {
    return { kind: 'computer', confidence: 'medium', suggestedDriver: null };
  }
  const pcVendors = ['dell', 'hewlett packard', 'lenovo', 'asustek', 'micro-star', 'gigabyte', 'intel corporate', 'wnc corporation'];
  if (pcVendors.some((v) => vendor.includes(v))) {
    return { kind: 'computer', confidence: 'low', suggestedDriver: null };
  }
  const phoneVendors = ['xiaomi mobile', 'apple', 'samsung electronics', 'oneplus', 'huawei', 'google, inc'];
  if (phoneVendors.some((v) => vendor.includes(v)) && input.openPorts.length === 0) {
    return { kind: 'phone', confidence: 'low', suggestedDriver: null };
  }

  // --- Networking hardware ----------------------------------------------
  // Deliberately NOT 'router'. Exactly one device on a network is the router —
  // the default gateway, handled at the top of this function. Everything else
  // from a networking vendor is an extender, a set-top box, an access point or
  // a smart plug that happens to use TP-Link silicon. Calling them all routers
  // is how a home ends up appearing to have five of them.
  const netVendors = [
    'sagemcom', 'arcadyan', 'vantiva', 'technicolor', 'zyxel',
    'tp-link', 'netgear', 'ubiquiti', 'mikrotik', 'wnc corporation',
  ];
  if (netVendors.some((v) => vendor.includes(v))) {
    return { kind: 'unknown', confidence: 'low', suggestedDriver: null };
  }

  return { kind: 'unknown', confidence: 'low', suggestedDriver: null };
}

/**
 * Human-friendly label for a device.
 *
 * Ordered by how much the source actually knows: a name the owner set, then a
 * model the device published, then its hostname, and only then a guess built
 * from the kind and vendor.
 */
export function displayNameFor(
  device: Pick<DiscoveredDevice, 'hostname' | 'vendor' | 'kind' | 'ip'> & {
    evidence?: Record<string, string | number | boolean>;
  },
): string {
  const ev = device.evidence ?? {};
  const friendly = ev['friendlyName'];
  if (typeof friendly === 'string' && friendly.trim()) return friendly.trim();

  const model = ev['modelName'] ?? ev['httpTitle'];
  if (typeof model === 'string' && model.trim()) return model.trim();

  if (device.hostname) return device.hostname;
  const kindLabel: Record<DeviceKind, string> = {
    router: 'Router',
    vacuum: 'Robot vacuum',
    light: 'Light',
    speaker: 'Speaker',
    tv: 'TV',
    media: 'Media player',
    camera: 'Camera',
    sensor: 'Sensor',
    plug: 'Smart plug',
    thermostat: 'Thermostat',
    printer: 'Printer',
    computer: 'Computer',
    phone: 'Phone',
    nas: 'NAS',
    hub: 'Hub',
    iot: 'Smart device',
    unknown: 'Unknown device',
  };
  const base = kindLabel[device.kind];
  return device.vendor ? `${base} (${device.vendor.split(/[ ,]/)[0]})` : `${base} ${device.ip}`;
}
