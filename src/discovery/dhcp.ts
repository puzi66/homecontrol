import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import { normaliseMac } from './net.js';

const log = logger('dhcp');

/**
 * Passive DHCP listener.
 *
 * Clients broadcast DISCOVER and REQUEST to 255.255.255.255:67, and those
 * packets carry things a device will not reveal any other way — a hostname it
 * chose for itself, and often a vendor class naming the firmware. Nothing is
 * sent; this only listens.
 *
 * It earns its keep on devices that answer no probe at all. One host here was
 * classified only as "unknown" by every active method, and announced itself in
 * DHCP as `mova_vacuum_r2475a`.
 *
 * The trade-off is timing: a client speaks when it boots and when it renews,
 * so identification arrives whenever it arrives rather than on demand.
 */

const PORT = 67;
const MAGIC_COOKIE = 0x63825363;

export interface DhcpSighting {
  mac: string;
  hostname: string | null;
  vendorClass: string | null;
  /** Requested-parameter ordering, a rough fingerprint of the network stack. */
  paramList: string | null;
  at: string;
}

function parse(buf: Buffer): DhcpSighting | null {
  if (buf.length < 240) return null;
  if (buf.readUInt32BE(236) !== MAGIC_COOKIE) return null;

  const mac = normaliseMac(buf.subarray(28, 34).toString('hex'));
  if (!mac) return null;

  let hostname: string | null = null;
  let vendorClass: string | null = null;
  let paramList: string | null = null;

  let at = 240;
  while (at < buf.length) {
    const code = buf[at]!;
    if (code === 255) break;
    if (code === 0) {
      at += 1;
      continue;
    }

    const len = buf[at + 1] ?? 0;
    const value = buf.subarray(at + 2, at + 2 + len);
    at += 2 + len;

    if (code === 12) hostname ??= value.toString('utf8').replace(/\0/g, '').trim() || null;
    else if (code === 60) vendorClass ??= value.toString('utf8').replace(/\0/g, '').trim() || null;
    else if (code === 55) paramList ??= [...value].join(',');
  }

  if (!hostname && !vendorClass) return null; // nothing worth recording
  return { mac, hostname, vendorClass, paramList, at: new Date().toISOString() };
}

class DhcpWatcher extends EventEmitter {
  #socket: dgram.Socket | null = null;
  #running = false;

  get running(): boolean {
    return this.#running;
  }

  /**
   * Start listening. Never throws: binding port 67 can fail because something
   * else holds it, and a home dashboard should not refuse to start over an
   * optional enrichment pass.
   */
  start(): void {
    if (this.#socket) return;

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', (err) => {
      log.warn(
        `not listening for DHCP (${err.message}). Device names will come from ` +
          'scans alone, which is a little less precise.',
      );
      this.#running = false;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      this.#socket = null;
    });

    socket.on('message', (buf) => {
      let sighting: DhcpSighting | null = null;
      try {
        sighting = parse(buf);
      } catch {
        return; // malformed packet
      }
      if (!sighting) return;

      log.info(
        `${sighting.mac} announced itself as ` +
          `${sighting.hostname ?? '(no hostname)'}${sighting.vendorClass ? ` / ${sighting.vendorClass}` : ''}`,
      );
      this.emit('sighting', sighting);
    });

    socket.bind(PORT, () => {
      this.#running = true;
      log.info('listening for DHCP announcements on port 67');
    });

    this.#socket = socket;
  }

  stop(): void {
    try {
      this.#socket?.close();
    } catch {
      /* already closed */
    }
    this.#socket = null;
    this.#running = false;
  }
}

export const dhcpWatcher = new DhcpWatcher();
