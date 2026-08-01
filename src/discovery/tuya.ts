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

/** Read a JSON object out of a buffer, plain or AES-ECB encrypted. */
function decodeBody(slice: Buffer): Record<string, unknown> | null {
  // Protocol 3.x prepends a 15-byte version header before the ciphertext.
  let body = slice;
  if (body.length > 15 && /^3\.\d$/.test(body.subarray(0, 3).toString('latin1'))) {
    body = body.subarray(15);
  }

  const asText = body.toString('utf8');
  const braceAt = asText.indexOf('{');
  if (braceAt >= 0) {
    try {
      return JSON.parse(asText.slice(braceAt)) as Record<string, unknown>;
    } catch {
      /* fall through to the decrypt path */
    }
  }

  if (body.length === 0 || body.length % 16 !== 0) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    const at = plain.indexOf('{');
    return at < 0 ? null : (JSON.parse(plain.slice(at)) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Pull the JSON body out of a Tuya frame.
 *
 * The framing is not fixed. After the 16-byte header some frames carry a 4-byte
 * return code before the ciphertext, and the trailer is either CRC32 plus the
 * suffix (8 bytes) or, from protocol 3.4, an HMAC-SHA256 plus the suffix (36).
 * Assuming one layout silently drops every device using another — measured on
 * real hardware, all four devices on the network were being rejected because
 * their payload carried a return code, leaving a ciphertext length that was not
 * a multiple of the AES block size.
 *
 * So rather than guess, try the plausible windows and keep whichever decodes.
 */
function parseFrame(buf: Buffer): Record<string, unknown> | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== PREFIX) return null;

  const declared = buf.readUInt32BE(12);
  const end = Math.min(16 + declared, buf.length);

  for (const returnCode of [4, 0]) {
    for (const trailer of [8, 36]) {
      const start = 16 + returnCode;
      const stop = end - trailer;
      if (stop - start < 16) continue;

      const decoded = decodeBody(buf.subarray(start, stop));
      if (decoded) return decoded;
    }
  }
  return null;
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
