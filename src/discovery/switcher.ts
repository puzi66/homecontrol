import dgram from 'node:dgram';
import { logger } from '../logger.js';
import { normaliseMac } from './net.js';

const log = logger('switcher');

/**
 * Passive Switcher discovery.
 *
 * Switcher devices (water heaters, power plugs, shutters) broadcast their full
 * state on UDP every few seconds without being asked — port 20002 for the older
 * Type 1 range and 20003 for Breeze and Runner. We just listen.
 *
 * The field offsets below were read off a real 165-byte broadcast rather than
 * copied from a spec: the IP and MAC embedded in the packet were cross-checked
 * against the same device's ARP entry, which is what confirms the layout.
 */

const PORTS = [20002, 20003];

/** Every broadcast starts with this magic. */
const MAGIC = 0xfef0;

export interface SwitcherRecord {
  ip: string;
  /** 3-byte device id, hex. This is the credential Type 1 control needs. */
  deviceId: string;
  name: string;
  mac: string | null;
  /** True when the relay is closed — heating, or the socket is live. */
  on: boolean;
  /** Instantaneous power draw in watts. */
  watts: number;
  /** Seconds left on the running timer, 0 when idle. */
  remainingSeconds: number;
  /** Configured auto-shutdown in seconds. */
  autoShutdownSeconds: number;
  /** Which port it announced on — 20003 means Breeze/Runner, a different API. */
  port: number;
}

function parseBroadcast(buf: Buffer, ip: string, port: number): SwitcherRecord | null {
  // Type 1 broadcasts are 165 bytes; Breeze/Runner are longer.
  if (buf.length < 165) return null;
  if (buf.readUInt16BE(0) !== MAGIC) return null;

  const deviceId = buf.subarray(18, 21).toString('hex');

  // 32-byte null-padded name field.
  const name = buf.subarray(42, 74).toString('utf8').replace(/\0+$/, '').trim();

  const macBytes = buf.subarray(80, 86);
  const mac = normaliseMac(macBytes.toString('hex'));

  // The relay state word: 0x0001 closed, 0x0000 open.
  const on = buf[133] === 0x01;

  return {
    ip,
    deviceId,
    name: name || `Switcher ${deviceId}`,
    mac,
    on,
    watts: buf.readUInt16LE(135),
    remainingSeconds: buf.readUInt32LE(147),
    autoShutdownSeconds: buf.readUInt32LE(155),
    port,
  };
}

/**
 * Listen for Switcher broadcasts.
 *
 * Devices announce roughly every four seconds, so a short window can miss one.
 * The default is deliberately longer than the other passive listeners.
 */
export async function discoverSwitcher(listenMs = 7000): Promise<SwitcherRecord[]> {
  const byIp = new Map<string, SwitcherRecord>();

  const sockets = await Promise.all(
    PORTS.map(
      (port) =>
        new Promise<dgram.Socket>((resolve) => {
          const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
          socket.on('error', (err) => {
            log.debug(`port ${port}: ${err.message}`);
            resolve(socket);
          });
          socket.on('message', (buf, rinfo) => {
            const record = parseBroadcast(buf, rinfo.address, port);
            if (record) byIp.set(rinfo.address, record);
          });
          socket.bind(port, () => resolve(socket));
        }),
    ),
  );

  await new Promise((r) => setTimeout(r, listenMs));

  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  const results = [...byIp.values()];
  if (results.length > 0) log.info(`heard ${results.length} Switcher device(s)`);
  return results;
}

/** Wait for one broadcast from a specific address — used by the driver for state. */
export async function readSwitcherState(ip: string, timeoutMs = 12_000): Promise<SwitcherRecord | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;

    const finish = (value: SwitcherRecord | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('message', (buf, rinfo) => {
      if (rinfo.address !== ip) return;
      const record = parseBroadcast(buf, rinfo.address, 20002);
      if (record) finish(record);
    });
    socket.bind(20002);
  });
}
