import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { logger } from '../logger.js';

const log = logger('tuya');

/**
 * Passive Tuya discovery.
 *
 * Every Tuya device shouts a UDP broadcast about itself every few seconds
 * without being asked — plaintext JSON on port 6666 (protocol 3.1) and
 * AES-encrypted on 6667 (3.3 and later). We just listen.
 *
 * The 6667 key is not a secret: it is MD5("yGAdlopoPVldABfn"), hard-coded
 * identically in every Tuya device and in the vendor's own SDK.
 */

const PORTS = [6666, 6667, 7000];
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

const PREFIX = 0x000055aa;
const SUFFIX = 0x0000aa55;

export interface TuyaRecord {
  ip: string;
  /** Device id on the Tuya cloud — unique per physical unit. */
  gwId: string | null;
  /** Product key: identifies the model/firmware bundle. */
  productKey: string | null;
  /** Protocol version, e.g. "3.3". */
  version: string | null;
  /** True when the device has been bound to a Tuya account. */
  active: boolean | null;
  /** True when the device expects encrypted local control. */
  encrypted: boolean;
  raw: Record<string, unknown>;
}

/** Pull the JSON body out of a Tuya frame, decrypting when necessary. */
function parseFrame(buf: Buffer): Record<string, unknown> | null {
  if (buf.length < 20) return null;
  if (buf.readUInt32BE(0) !== PREFIX) return null;

  const payloadLength = buf.readUInt32BE(12);
  if (payloadLength < 4 || 16 + payloadLength > buf.length) return null;

  // Trailing 8 bytes of the declared length are the CRC and the suffix.
  let payload = buf.subarray(16, 16 + payloadLength - 8);

  // Protocol 3.3 prepends a 15-byte version header before the ciphertext.
  if (payload.length > 15 && payload.subarray(0, 3).toString('ascii') === '3.3') {
    payload = payload.subarray(15);
  }

  const asText = payload.toString('utf8');
  const braceAt = asText.indexOf('{');
  if (braceAt >= 0) {
    try {
      return JSON.parse(asText.slice(braceAt)) as Record<string, unknown>;
    } catch {
      /* fall through to the decrypt path */
    }
  }

  // AES-128-ECB with the well-known broadcast key.
  if (payload.length % 16 !== 0) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null);
    const plain = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
    const at = plain.indexOf('{');
    if (at < 0) return null;
    return JSON.parse(plain.slice(at)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toRecord(ip: string, data: Record<string, unknown>): TuyaRecord {
  const str = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : null);
  return {
    ip,
    gwId: str('gwId') ?? str('devId'),
    productKey: str('productKey'),
    version: str('version'),
    active: typeof data['active'] === 'number' ? data['active'] > 0 : null,
    encrypted: data['encrypt'] === true || typeof data['version'] === 'string',
    raw: data,
  };
}

/**
 * Listen for Tuya broadcasts.
 *
 * `listenMs` needs to be generous — devices announce on their own schedule,
 * typically every 5 to 10 seconds, so a short window silently misses some.
 */
export async function discoverTuya(listenMs = 25_000): Promise<TuyaRecord[]> {
  const byIp = new Map<string, TuyaRecord>();

  const sockets = PORTS.map((port) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => log.debug(`port ${port}: ${err.message}`));
    socket.on('message', (buf, rinfo) => {
      const data = parseFrame(buf);
      if (!data) return;
      const record = toRecord(rinfo.address, data);
      // Later frames carry the same content; keep the first, richest one.
      if (!byIp.has(rinfo.address) || !byIp.get(rinfo.address)!.gwId) {
        byIp.set(rinfo.address, record);
      }
    });
    return new Promise<dgram.Socket>((resolve) => {
      socket.bind(port, () => resolve(socket));
    });
  });

  const bound = await Promise.all(sockets);
  await new Promise((r) => setTimeout(r, listenMs));

  for (const socket of bound) {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  const results = [...byIp.values()];
  log.info(`heard ${results.length} Tuya device(s)`);
  return results;
}
