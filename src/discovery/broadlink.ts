import dgram from 'node:dgram';
import { logger } from '../logger.js';
import { normaliseMac } from './net.js';

const log = logger('broadlink');

/**
 * Broadlink discovery.
 *
 * Broadlink gear (IR blasters, smart plugs, sensors) answers a specific 48-byte
 * UDP probe on port 80 with a device-type code that pins down the exact model.
 * The probe embeds the sender's clock and address; devices ignore malformed or
 * unchecksummed packets.
 */

const PORT = 80;

/**
 * Device type code -> model. Broadlink reuses codes liberally across firmware
 * revisions, so anything unlisted is reported as its raw hex code rather than
 * guessed at.
 */
const DEVICE_TYPES: Record<number, string> = {
  0x2711: 'SP2 smart plug',
  0x2719: 'SP2 smart plug (Honeywell)',
  0x271a: 'SP2 smart plug',
  0x2720: 'SP Mini plug',
  0x2728: 'SP2 Mini plug',
  0x2733: 'SP3 smart plug',
  0x273e: 'SP Mini plug',
  0x7530: 'SP2 smart plug (OEM)',
  0x753e: 'SP3 smart plug',
  0x7919: 'SP2 smart plug (Honeywell)',
  0x791a: 'SP2 smart plug (Honeywell)',
  0x7d00: 'SP3S energy plug',
  0x947a: 'SP3S energy plug',
  0x9479: 'SP3S energy plug',
  0x756c: 'SP4M plug',
  0x7546: 'SP4L plug',
  0x7579: 'SP4L-EU plug',

  0x2712: 'RM2 IR blaster',
  0x2737: 'RM Mini 3 IR blaster',
  0x273d: 'RM Pro IR blaster (Phicomm)',
  0x277c: 'RM2 Home Plus GDT',
  0x2783: 'RM2 Home Plus',
  0x272a: 'RM2 Pro Plus',
  0x2787: 'RM2 Pro Plus 2',
  0x278b: 'RM2 Pro Plus BL',
  0x278f: 'RM Mini (Shate)',
  0x2797: 'RM2 Pro Plus HYC',
  0x27a1: 'RM2 Pro Plus R1',
  0x27a6: 'RM2 Pro PP',
  0x27c2: 'RM Mini 3 IR blaster',
  0x27c7: 'RM Mini 3 IR blaster',
  0x27c3: 'RM Pro+ IR/RF blaster',
  0x27cc: 'RM Mini 3 IR blaster',
  0x27cd: 'RM Mini 3 IR blaster',
  0x27d0: 'RM Mini 3 IR blaster',
  0x27d1: 'RM Mini 3 IR blaster',
  0x27d3: 'RM Mini 3 IR blaster',
  0x27de: 'RM Mini 3 IR blaster',
  0x51da: 'RM4 Mini IR blaster',
  0x5f36: 'RM Mini 3 / RM4 Mini',
  0x6026: 'RM4 Pro IR/RF blaster',
  0x6070: 'RM4C Mini IR blaster',
  0x610e: 'RM4 Mini IR blaster',
  0x610f: 'RM4C Mini IR blaster',
  0x61a2: 'RM4 Pro IR/RF blaster',
  0x62bc: 'RM4 Mini IR blaster',
  0x62be: 'RM4C Mini IR blaster',
  0x6184: 'RM4C Pro IR/RF blaster',
  0x648d: 'RM4 Mini IR blaster',
  0x649b: 'RM4 Pro IR/RF blaster',
  0x653a: 'RM4 Mini IR blaster',
  0x653c: 'RM4 Pro IR/RF blaster',

  0x2714: 'A1 environment sensor',
  0x4ead: 'A1 environment sensor',
  0x4e4d: 'Dooya curtain motor',
  0x4eb5: 'MP1 power strip',
  0x4ef7: 'MP1 power strip (Honyar)',
  0x4f1b: 'MP1 power strip',
  0x4f65: 'MP1 power strip',
  0x51e3: 'BG1 wall switch',
  0x60c8: 'LB1 smart bulb',
  0x6112: 'LB1 smart bulb',
  0x5043: 'SB800TD light switch',
};

export interface BroadlinkRecord {
  ip: string;
  mac: string | null;
  /** Raw 16-bit device type code. */
  deviceType: number;
  /** Model name when we recognise the code. */
  model: string | null;
  /** Friendly name the device reports, when firmware supplies one. */
  name: string | null;
  /** True when the device has been locked to an account. */
  locked: boolean;
}

/** Build the 48-byte probe. Layout follows Broadlink's own SDK. */
function buildProbe(localIp: string, localPort: number): Buffer {
  const packet = Buffer.alloc(0x30);
  const now = new Date();

  // Timezone offset in hours, as a signed byte quad.
  const tzHours = -now.getTimezoneOffset() / 60;
  if (tzHours < 0) {
    packet.writeInt32LE(Math.trunc(tzHours), 0x08);
    packet[0x0c] = 0xff;
    packet[0x0d] = 0xff;
  } else {
    packet.writeInt32LE(Math.trunc(tzHours), 0x08);
  }

  const year = now.getFullYear();
  packet.writeUInt16LE(year, 0x0c);
  packet[0x0e] = now.getMinutes();
  packet[0x0f] = now.getHours();
  packet[0x10] = year % 100;
  packet[0x11] = now.getDay();
  packet[0x12] = now.getDate();
  packet[0x13] = now.getMonth() + 1;

  const octets = localIp.split('.').map(Number);
  packet[0x18] = octets[0]!;
  packet[0x19] = octets[1]!;
  packet[0x1a] = octets[2]!;
  packet[0x1b] = octets[3]!;
  packet.writeUInt16LE(localPort, 0x1c);

  packet[0x26] = 6; // command: discover

  // Checksum starts from the constant 0xbeaf and covers the whole packet.
  let checksum = 0xbeaf;
  for (const byte of packet) checksum += byte;
  packet.writeUInt16LE(checksum & 0xffff, 0x20);

  return packet;
}

function parseResponse(buf: Buffer, ip: string): BroadlinkRecord | null {
  if (buf.length < 0x40) return null;

  const deviceType = buf.readUInt16LE(0x34);
  if (deviceType === 0) return null;

  // MAC is stored little-endian across 0x3a..0x40.
  const macBytes = Buffer.from(buf.subarray(0x3a, 0x40)).reverse();
  const mac = normaliseMac(macBytes.toString('hex'));

  // Newer firmware appends a null-terminated friendly name.
  let name: string | null = null;
  if (buf.length > 0x40) {
    const tail = buf.subarray(0x40);
    const end = tail.indexOf(0);
    const text = tail.subarray(0, end < 0 ? tail.length : end).toString('utf8').trim();
    if (text) name = text;
  }

  return {
    ip,
    mac,
    deviceType,
    model: DEVICE_TYPES[deviceType] ?? null,
    name,
    locked: buf.length > 0x7f ? buf[0x7f] !== 0 : false,
  };
}

/**
 * Broadcast the probe and collect responders.
 *
 * @param localIp     address to advertise in the probe (must be the real one)
 * @param broadcasts  subnet broadcast addresses to target
 */
export async function discoverBroadlink(
  localIp: string,
  broadcasts: string[],
  listenMs = 5000,
): Promise<BroadlinkRecord[]> {
  const byIp = new Map<string, BroadlinkRecord>();

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', (err) => log.debug(`socket error: ${err.message}`));
  socket.on('message', (buf, rinfo) => {
    const record = parseResponse(buf, rinfo.address);
    if (record) byIp.set(rinfo.address, record);
  });

  await new Promise<void>((resolve) => socket.bind(0, resolve));
  const localPort = socket.address().port;
  try {
    socket.setBroadcast(true);
  } catch {
    /* not fatal */
  }

  const probe = buildProbe(localIp, localPort);
  const targets = [...new Set([...broadcasts, '255.255.255.255'])];

  // Broadcast replies drop under load, same as miio, so send a few rounds.
  for (let round = 0; round < 3; round++) {
    await Promise.all(
      targets.map(
        (addr) =>
          new Promise<void>((resolve) => {
            socket.send(probe, 0, probe.length, PORT, addr, () => resolve());
          }),
      ),
    );
    await new Promise((r) => setTimeout(r, Math.floor(listenMs / 3)));
  }

  socket.close();

  const results = [...byIp.values()];
  log.info(`found ${results.length} Broadlink device(s)`);
  return results;
}
