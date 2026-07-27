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
  const model = String(ev['modelName'] ?? ev['ssdpServer'] ?? '').toLowerCase();

  // --- Gateway -----------------------------------------------------------
  if (input.gateway && input.ip === input.gateway) {
    return { kind: 'router', confidence: 'high', suggestedDriver: null };
  }

  // --- Robot vacuums -----------------------------------------------------
  // AltoBeam is Dreame's WiFi silicon and MOVA is Dreame's sub-brand, so an
  // AltoBeam device answering miio is a vacuum. Other miio responders fall
  // through to the rules below — a Xiaomi smart speaker speaks miio too — and
  // are picked up by the generic miio rule further down.
  const speaksMiio = ev['miioDeviceId'] !== undefined;
  if (speaksMiio) {
    const vacuumish =
      vendor.includes('altobeam') ||
      vendor.includes('dreame') ||
      vendor.includes('roborock') ||
      host.includes('vacuum') ||
      host.includes('mova') ||
      host.includes('dreame');
    if (vacuumish) return { kind: 'vacuum', confidence: 'high', suggestedDriver: 'mova' };
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
  // 6668 is Tuya's local control port. Controlling one needs a per-device local
  // key from the Tuya cloud, so no driver is suggested.
  if (ports.has(6668) || ev['tuyaGwId'] !== undefined) {
    return { kind: 'iot', confidence: 'high', suggestedDriver: null };
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
    return { kind: 'hub', confidence: 'high', suggestedDriver: 'homeassistant' };
  }
  if (hasService('_esphomelib') || ports.has(6053)) {
    return { kind: 'iot', confidence: 'high', suggestedDriver: 'esphome' };
  }
  if (hasService('_matter')) return { kind: 'iot', confidence: 'medium', suggestedDriver: 'matter' };
  if (hasService('_hap')) return { kind: 'iot', confidence: 'medium', suggestedDriver: 'homekit' };
  if (ports.has(1883)) return { kind: 'hub', confidence: 'medium', suggestedDriver: 'mqtt' };

  // --- Cameras -----------------------------------------------------------
  if (ports.has(554) || host.includes('cam') || model.includes('camera')) {
    return { kind: 'camera', confidence: 'medium', suggestedDriver: null };
  }

  // --- Printers ----------------------------------------------------------
  if (ports.has(631) || ports.has(9100) || hasService('_printer') || hasService('_ipp')) {
    return { kind: 'printer', confidence: 'high', suggestedDriver: null };
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

  // --- Routers and infrastructure ---------------------------------------
  const netVendors = ['sagemcom', 'arcadyan', 'vantiva', 'technicolor', 'zyxel', 'tp-link', 'netgear', 'ubiquiti', 'mikrotik'];
  if (netVendors.some((v) => vendor.includes(v))) {
    return { kind: 'router', confidence: 'low', suggestedDriver: null };
  }

  return { kind: 'unknown', confidence: 'low', suggestedDriver: null };
}

/** Human-friendly fallback label when a device has no name of its own. */
export function displayNameFor(device: Pick<DiscoveredDevice, 'hostname' | 'vendor' | 'kind' | 'ip'>): string {
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
