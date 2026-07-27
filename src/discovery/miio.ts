import dgram from 'node:dgram';
import { logger } from '../logger.js';

const log = logger('miio');

export const MIIO_PORT = 54321;

/**
 * The miio "hello" packet: magic 0x2131, length 0x0020, then 28 bytes of 0xFF.
 * Every Xiaomi-ecosystem device — which includes Dreame and its MOVA sub-brand —
 * answers this with its device id and uptime stamp.
 */
const HELLO = Buffer.concat([Buffer.from([0x21, 0x31, 0x00, 0x20]), Buffer.alloc(28, 0xff)]);

export interface MiioRecord {
  ip: string;
  /** Numeric device id, stable per device and used as the miio "did". */
  deviceId: number;
  /** Device uptime in seconds, as reported in the handshake. */
  stamp: number;
  /**
   * The 16-byte device token, hex encoded — or null when the device withholds it.
   * Newer firmware returns all-0xFF here once the device has been paired to an
   * app, in which case the token has to come from the vendor cloud instead.
   */
  token: string | null;
}

/**
 * Broadcast the miio handshake and collect every responder.
 *
 * Broadcast replies are lossy — measured on a real LAN, a single round reliably
 * drops one responder or another — so the hello goes out several times across
 * the listen window. Even then, treat this as a fast first pass: `probeMiioBatch`
 * below is the authoritative check once the host list is known.
 *
 * @param broadcastAddresses one per subnet, e.g. ["192.168.1.255"]
 */
export async function discoverMiio(listenMs: number, broadcastAddresses: string[]): Promise<MiioRecord[]> {
  const byIp = new Map<string, MiioRecord>();

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', (err) => log.debug(`socket error: ${err.message}`));

  socket.on('message', (buf, rinfo) => {
    const record = parseHello(buf, rinfo.address);
    if (record) byIp.set(rinfo.address, record);
  });

  await new Promise<void>((resolve) => socket.bind(0, resolve));
  try {
    socket.setBroadcast(true);
  } catch {
    /* not fatal */
  }

  const blast = () =>
    Promise.all(
      broadcastAddresses.map(
        (addr) =>
          new Promise<void>((resolve) => {
            socket.send(HELLO, 0, HELLO.length, MIIO_PORT, addr, () => resolve());
          }),
      ),
    );

  const rounds = 3;
  const gap = Math.max(300, Math.floor(listenMs / (rounds + 1)));
  for (let i = 0; i < rounds; i++) {
    await blast();
    await new Promise((r) => setTimeout(r, gap));
  }
  await new Promise((r) => setTimeout(r, Math.max(0, listenMs - rounds * gap)));

  socket.close();

  const results = [...byIp.values()];
  log.debug(`found ${results.length} miio devices via broadcast`);
  return results;
}

/**
 * Unicast-probe a list of addresses. Unlike the broadcast pass this is reliable,
 * so it is what decides whether a host really speaks miio.
 */
export async function probeMiioBatch(
  ips: string[],
  timeoutMs = 1200,
  concurrency = 16,
): Promise<MiioRecord[]> {
  const out: MiioRecord[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < ips.length) {
      const ip = ips[cursor++]!;
      const record = await probeMiio(ip, timeoutMs);
      if (record) out.push(record);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker));
  log.debug(`unicast probe found ${out.length} miio devices across ${ips.length} host(s)`);
  return out;
}

/** Probe one address directly. Used when re-checking a known device. */
export async function probeMiio(ip: string, timeoutMs = 2000): Promise<MiioRecord | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (value: MiioRecord | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };

    socket.on('error', () => finish(null));
    socket.on('message', (buf) => finish(parseHello(buf, ip)));
    socket.send(HELLO, 0, HELLO.length, MIIO_PORT, ip, (err) => {
      if (err) finish(null);
    });

    setTimeout(() => finish(null), timeoutMs);
  });
}

function parseHello(buf: Buffer, ip: string): MiioRecord | null {
  if (buf.length < 32) return null;
  if (buf.readUInt16BE(0) !== 0x2131) return null;

  const deviceId = buf.readUInt32BE(8);
  const stamp = buf.readUInt32BE(12);
  const tokenBytes = buf.subarray(16, 32);

  // All-0xFF (withheld) or all-0x00 (not yet provisioned) are not real tokens.
  const isAllFF = tokenBytes.every((b) => b === 0xff);
  const isAllZero = tokenBytes.every((b) => b === 0x00);
  const token = isAllFF || isAllZero ? null : tokenBytes.toString('hex');

  return { ip, deviceId, stamp, token };
}
