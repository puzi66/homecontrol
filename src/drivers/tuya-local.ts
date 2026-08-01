import crypto from 'node:crypto';
import net from 'node:net';
import { logger } from '../logger.js';

const log = logger('tuya-local');

/**
 * Tuya local control over TCP 6668.
 *
 * Two protocol generations are in play and they are not variations of each
 * other. 3.3 encrypts each message directly with the device's local key. From
 * 3.4 the device first negotiates a per-connection session key and signs every
 * frame with HMAC-SHA256 instead of a CRC — so a 3.4 device rejects everything a
 * 3.3 client sends, and vice versa.
 *
 * Framing and the negotiation follow the tinytuya project (MIT), transcribed
 * from its source rather than reconstructed from memory.
 */

const PORT = 6668;
const PREFIX = 0x000055aa;
const SUFFIX = 0x0000aa55;

const CMD = {
  SESS_KEY_NEG_START: 0x03,
  SESS_KEY_NEG_RESP: 0x04,
  SESS_KEY_NEG_FINISH: 0x05,
  CONTROL: 0x07,
  DP_QUERY: 0x0a,
  CONTROL_NEW: 0x0d,
  DP_QUERY_NEW: 0x10,
} as const;

/** Commands that must not carry the "3.x" version header. */
const NO_HEADER = new Set<number>([
  CMD.DP_QUERY,
  CMD.SESS_KEY_NEG_START,
  CMD.SESS_KEY_NEG_RESP,
  CMD.SESS_KEY_NEG_FINISH,
]);

export class TuyaLocalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TuyaLocalError';
  }
}

// --- CRC32 ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ -1) >>> 0;
}

// --- AES -----------------------------------------------------------------

function aesEncrypt(key: Buffer, data: Buffer, pad = true): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(pad);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function aesDecrypt(key: Buffer, data: Buffer, pad = true): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(pad);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

const hmacSha256 = (key: Buffer, data: Buffer) =>
  crypto.createHmac('sha256', key).update(data).digest();

// --- framing -------------------------------------------------------------

/** Build a wire frame. With `hmacKey` the trailer is a 32-byte HMAC, else CRC32. */
function packMessage(seq: number, cmd: number, payload: Buffer, hmacKey: Buffer | null): Buffer {
  const trailerLength = hmacKey ? 32 : 4;
  const header = Buffer.alloc(16);
  header.writeUInt32BE(PREFIX, 0);
  header.writeUInt32BE(seq, 4);
  header.writeUInt32BE(cmd, 8);
  header.writeUInt32BE(payload.length + trailerLength + 4, 12);

  const withoutTrailer = Buffer.concat([header, payload]);
  const checksum = hmacKey
    ? hmacSha256(hmacKey, withoutTrailer)
    : (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(crc32(withoutTrailer), 0);
        return b;
      })();

  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(SUFFIX, 0);
  return Buffer.concat([withoutTrailer, checksum, suffix]);
}

interface Frame {
  seq: number;
  cmd: number;
  /** Payload with the return code and any version header already removed. */
  payload: Buffer;
}

/**
 * Split a frame apart.
 *
 * The return code is present on some responses and absent on others, and the
 * trailer is 8 or 36 bytes depending on protocol version — so rather than
 * assume, hand back the raw window and let the caller try the variants.
 */
function unpackMessage(buf: Buffer, hmac: boolean): Frame | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== PREFIX) return null;

  const seq = buf.readUInt32BE(4);
  const cmd = buf.readUInt32BE(8);
  const declared = buf.readUInt32BE(12);
  const end = Math.min(16 + declared, buf.length);
  const trailer = (hmac ? 32 : 4) + 4;

  const stop = end - trailer;
  if (stop <= 16) return { seq, cmd, payload: Buffer.alloc(0) };

  return { seq, cmd, payload: buf.subarray(16, stop) };
}

/** Strip an optional 4-byte return code and an optional "3.x" version header. */
function* payloadCandidates(payload: Buffer): Generator<Buffer> {
  for (const skip of [0, 4]) {
    if (payload.length <= skip) continue;
    let body = payload.subarray(skip);
    yield body;
    if (body.length > 15 && /^3\.\d$/.test(body.subarray(0, 3).toString('latin1'))) {
      yield body.subarray(15);
    }
  }
}

// --- device --------------------------------------------------------------

export interface TuyaStatus {
  dps: Record<string, unknown>;
}

/**
 * One connection to one device. Not reusable — construct, use, close.
 * Tuya devices accept a single client at a time and drop idle sockets quickly.
 */
export class TuyaDevice {
  #socket: net.Socket | null = null;
  #seq = 1;
  /** The key frames are encrypted with: the local key, or a session key on 3.4+. */
  #key: Buffer;
  readonly #localKey: Buffer;
  readonly #hmac: boolean;

  constructor(
    private readonly ip: string,
    private readonly deviceId: string,
    localKey: string,
    private readonly version: string,
    private readonly timeoutMs = 6000,
  ) {
    this.#localKey = Buffer.from(localKey, 'latin1');
    if (this.#localKey.length !== 16) {
      throw new TuyaLocalError(`local key must be 16 characters, got ${this.#localKey.length}`);
    }
    this.#key = this.#localKey;
    this.#hmac = Number(version) >= 3.4;
  }

  async connect(): Promise<void> {
    this.#socket = new net.Socket();
    const socket = this.#socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new TuyaLocalError(`${this.ip}: connection timed out`));
      }, this.timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new TuyaLocalError(`${this.ip}: ${err.message}`));
      });
      socket.connect(PORT, this.ip);
    });

    if (this.#hmac) await this.#negotiateSessionKey();
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }

  #send(cmd: number, payload: Buffer, expectReply: boolean): Promise<Frame | null> {
    const socket = this.#socket;
    if (!socket) throw new TuyaLocalError('not connected');

    let body = payload;
    if (this.#hmac && !NO_HEADER.has(cmd) && body.length > 0) {
      // 3.4+ prepends "3.4" and twelve zero bytes before encrypting.
      body = Buffer.concat([Buffer.from(this.version, 'latin1'), Buffer.alloc(12), body]);
    }

    // Every outgoing payload is PKCS7-padded, negotiation frames included — a
    // 16-byte nonce goes out as 32 bytes. Only the session-key derivation later
    // encrypts without padding, and that never touches the wire.
    let encrypted = body.length > 0 ? aesEncrypt(this.#key, body, true) : body;

    if (!this.#hmac && !NO_HEADER.has(cmd) && encrypted.length > 0) {
      // 3.3 puts the version header outside the ciphertext.
      encrypted = Buffer.concat([Buffer.from('3.3', 'latin1'), Buffer.alloc(12), encrypted]);
    }

    const frame = packMessage(this.#seq++, cmd, encrypted, this.#hmac ? this.#key : null);

    return new Promise((resolve, reject) => {
      let settled = false;
      let buffered = Buffer.alloc(0);

      const finish = (err: Error | null, value?: Frame | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener('data', onData);
        if (err) reject(err);
        else resolve(value ?? null);
      };

      /**
       * Devices commonly answer with a 28-byte empty acknowledgement before the
       * frame that actually carries data, and TCP is free to split or coalesce
       * either of them. So buffer, walk complete frames, and keep going until
       * one arrives with a payload.
       */
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);

        while (buffered.length >= 24) {
          const at = buffered.indexOf(Buffer.from([0x00, 0x00, 0x55, 0xaa]));
          if (at < 0) {
            buffered = Buffer.alloc(0);
            return;
          }
          if (at > 0) buffered = buffered.subarray(at);
          if (buffered.length < 16) return;

          const total = 16 + buffered.readUInt32BE(12);
          if (buffered.length < total) return; // wait for the rest

          const frameBuf = buffered.subarray(0, total);
          buffered = buffered.subarray(total);

          const parsed = unpackMessage(frameBuf, this.#hmac);
          if (parsed && parsed.payload.length > 0) return finish(null, parsed);
          // Empty payload: an ack. Keep waiting for the real answer.
        }
      };

      const timer = setTimeout(
        () => finish(expectReply ? new TuyaLocalError(`${this.ip}: no reply`) : null),
        this.timeoutMs,
      );

      if (expectReply) socket.on('data', onData);
      socket.write(frame, (err) => {
        if (err) finish(err);
        else if (!expectReply) finish(null, null);
      });
    });
  }

  /**
   * 3.4+ handshake: send a nonce, verify the device proves it knows the local
   * key, prove we know it too, then derive the session key from both nonces.
   */
  async #negotiateSessionKey(): Promise<void> {
    const localNonce = crypto.randomBytes(16);

    const reply = await this.#send(CMD.SESS_KEY_NEG_START, localNonce, true);
    if (!reply || reply.cmd !== CMD.SESS_KEY_NEG_RESP) {
      throw new TuyaLocalError('session key negotiation was refused');
    }

    let decoded: Buffer | null = null;
    for (const candidate of payloadCandidates(reply.payload)) {
      if (candidate.length < 48 || candidate.length % 16 !== 0) continue;
      try {
        const plain = aesDecrypt(this.#localKey, candidate, false);
        if (plain.length >= 48) {
          decoded = plain;
          break;
        }
      } catch {
        /* try the next window */
      }
    }
    if (!decoded) throw new TuyaLocalError('could not read the negotiation response — wrong local key?');

    const remoteNonce = decoded.subarray(0, 16);
    const expected = hmacSha256(this.#localKey, localNonce);
    if (!expected.equals(decoded.subarray(16, 48))) {
      throw new TuyaLocalError('the device failed to prove it knows the local key');
    }

    await this.#send(CMD.SESS_KEY_NEG_FINISH, hmacSha256(this.#localKey, remoteNonce), false);

    // Session key = the two nonces XORed, then encrypted with the local key.
    const mixed = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) mixed[i] = localNonce[i]! ^ remoteNonce[i]!;
    this.#key = aesEncrypt(this.#localKey, mixed, false);

    log.debug(`${this.ip}: session established`);
  }

  /** Decrypt a reply and parse the JSON inside it. */
  #decodeReply(frame: Frame): Record<string, unknown> | null {
    for (const candidate of payloadCandidates(frame.payload)) {
      // Some replies are plaintext JSON.
      const text = candidate.toString('utf8');
      const brace = text.indexOf('{');
      if (brace >= 0) {
        try {
          return JSON.parse(text.slice(brace)) as Record<string, unknown>;
        } catch {
          /* fall through */
        }
      }

      if (candidate.length === 0 || candidate.length % 16 !== 0) continue;
      try {
        const plain = aesDecrypt(this.#key, candidate, true).toString('utf8');
        const at = plain.indexOf('{');
        if (at >= 0) return JSON.parse(plain.slice(at)) as Record<string, unknown>;
      } catch {
        /* try the next window */
      }
    }
    return null;
  }

  /** Read the current data points. Read-only. */
  async status(): Promise<TuyaStatus> {
    const cmd = this.#hmac ? CMD.DP_QUERY_NEW : CMD.DP_QUERY;

    // 3.4 needs a real body here. Sent empty, the device answers with return
    // code 1 and no data — which looks exactly like a decryption failure and is
    // not one.
    const payload = this.#hmac
      ? Buffer.from(
          JSON.stringify({ protocol: 4, t: Math.round(Date.now() / 1000), data: {} }),
          'utf8',
        )
      : Buffer.from(JSON.stringify({ gwId: this.deviceId, devId: this.deviceId }), 'utf8');

    const reply = await this.#send(cmd, payload, true);
    if (!reply) throw new TuyaLocalError('no status returned');

    const parsed = this.#decodeReply(reply);
    if (!parsed) throw new TuyaLocalError('could not decode the status — wrong local key or version?');

    const dps = (parsed['dps'] ?? (parsed['data'] as Record<string, unknown>)?.['dps'] ?? {}) as Record<string, unknown>;
    return { dps };
  }

  /** Set one or more data points. This physically actuates the device. */
  async setDps(dps: Record<string, unknown>): Promise<void> {
    const now = Math.round(Date.now() / 1000);

    const [cmd, payload] = this.#hmac
      ? ([CMD.CONTROL_NEW, { protocol: 5, t: now, data: { dps } }] as const)
      : ([CMD.CONTROL, { devId: this.deviceId, uid: this.deviceId, t: String(now), dps }] as const);

    await this.#send(cmd, Buffer.from(JSON.stringify(payload), 'utf8'), true);
    log.info(`${this.ip}: set ${JSON.stringify(dps)}`);
  }
}

/** Open a connection, run something, always close. */
export async function withTuya<T>(
  ip: string,
  deviceId: string,
  localKey: string,
  version: string,
  run: (device: TuyaDevice) => Promise<T>,
): Promise<T> {
  const device = new TuyaDevice(ip, deviceId, localKey, version);
  await device.connect();
  try {
    return await run(device);
  } finally {
    device.close();
  }
}
