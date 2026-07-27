import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { MIIO_PORT, probeMiio } from '../discovery/miio.js';
import { logger } from '../logger.js';

const log = logger('miio-proto');

/**
 * The miio binary protocol used by Xiaomi, Dreame and MOVA devices.
 *
 * Packet layout (little of it is documented by the vendor; this follows the
 * community reverse-engineering that python-miio also implements):
 *
 *   0x00  magic      2 bytes, always 0x2131
 *   0x02  length     2 bytes, whole packet including header
 *   0x04  unknown    4 bytes, zero for commands
 *   0x08  device id  4 bytes
 *   0x0c  stamp      4 bytes, device uptime in seconds
 *   0x10  checksum  16 bytes, MD5 over the packet with the token in this slot
 *   0x20  payload    AES-128-CBC ciphertext of the JSON request
 *
 * The AES key is MD5(token) and the IV is MD5(key ++ token).
 */

const MAGIC = 0x2131;
const HEADER_LEN = 32;

function md5(...parts: Buffer[]): Buffer {
  const hash = crypto.createHash('md5');
  for (const p of parts) hash.update(p);
  return hash.digest();
}

function keysFor(token: Buffer): { key: Buffer; iv: Buffer } {
  const key = md5(token);
  return { key, iv: md5(key, token) };
}

function encryptPayload(token: Buffer, plain: Buffer): Buffer {
  const { key, iv } = keysFor(token);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function decryptPayload(token: Buffer, encrypted: Buffer): Buffer {
  const { key, iv } = keysFor(token);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function buildPacket(token: Buffer, deviceId: number, stamp: number, payload: Buffer | null): Buffer {
  const encrypted = payload ? encryptPayload(token, payload) : Buffer.alloc(0);
  const packet = Buffer.alloc(HEADER_LEN + encrypted.length);

  packet.writeUInt16BE(MAGIC, 0);
  packet.writeUInt16BE(packet.length, 2);
  packet.writeUInt32BE(0, 4);
  packet.writeUInt32BE(deviceId, 8);
  packet.writeUInt32BE(stamp, 12);
  // The checksum slot holds the raw token while the digest is computed.
  token.copy(packet, 16);
  encrypted.copy(packet, HEADER_LEN);

  md5(packet).copy(packet, 16);
  return packet;
}

export interface MiioCallOptions {
  ip: string;
  /** 32 hex characters. */
  token: string;
  timeoutMs?: number;
}

export class MiioError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'MiioError';
  }
}

/**
 * A connection to one miio device.
 *
 * The device rejects packets whose stamp has drifted, so we re-handshake to
 * resynchronise and then track the clock offset locally between calls.
 */
export class MiioDevice {
  #ip: string;
  #token: Buffer;
  #timeoutMs: number;
  #deviceId = 0;
  #stampBase = 0;
  /** Local monotonic reading taken when #stampBase was captured. */
  #stampReadAt = 0;
  #requestId = 1;

  constructor(options: MiioCallOptions) {
    if (!/^[0-9a-fA-F]{32}$/.test(options.token)) {
      throw new MiioError('token must be 32 hex characters');
    }
    this.#ip = options.ip;
    this.#token = Buffer.from(options.token, 'hex');
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  get ip(): string {
    return this.#ip;
  }

  /** Handshake to learn the device id and clock. Safe to call repeatedly. */
  async handshake(): Promise<void> {
    const hello = await probeMiio(this.#ip, this.#timeoutMs);
    if (!hello) throw new MiioError(`${this.#ip} did not answer the miio handshake`);
    this.#deviceId = hello.deviceId;
    this.#stampBase = hello.stamp;
    this.#stampReadAt = Date.now();
  }

  #currentStamp(): number {
    return this.#stampBase + Math.floor((Date.now() - this.#stampReadAt) / 1000);
  }

  /** Send one JSON-RPC style command and return the `result` field. */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (this.#deviceId === 0) await this.handshake();

    const id = this.#requestId++;
    if (this.#requestId > 9999) this.#requestId = 1;

    const request = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    const packet = buildPacket(this.#token, this.#deviceId, this.#currentStamp(), request);
    const reply = await this.#exchange(packet);

    if (reply.length <= HEADER_LEN) {
      throw new MiioError(`${this.#ip} returned an empty response to ${method}`);
    }

    let decoded: string;
    try {
      decoded = decryptPayload(this.#token, reply.subarray(HEADER_LEN)).toString('utf8').replace(/\0+$/, '');
    } catch {
      // Decryption only fails when the key is wrong, which means a bad token.
      throw new MiioError(`could not decrypt the reply from ${this.#ip} — the token is probably wrong`);
    }

    let parsed: { result?: T; error?: { code?: number; message?: string } };
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new MiioError(`${this.#ip} returned malformed JSON: ${decoded.slice(0, 120)}`);
    }

    if (parsed.error) {
      throw new MiioError(parsed.error.message ?? 'device reported an error', parsed.error.code);
    }
    return parsed.result as T;
  }

  #exchange(packet: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      let settled = false;

      const finish = (err: Error | null, data?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        if (err) reject(err);
        else resolve(data!);
      };

      const timer = setTimeout(
        () => finish(new MiioError(`${this.#ip} timed out after ${this.#timeoutMs}ms`)),
        this.#timeoutMs,
      );

      socket.on('error', (err) => finish(err));
      socket.on('message', (buf) => finish(null, buf));
      socket.send(packet, 0, packet.length, MIIO_PORT, this.#ip, (err) => {
        if (err) finish(err);
      });
    });
  }

  /**
   * MIoT spec properties, used by every recent Dreame/MOVA model.
   * `props` are {siid, piid} pairs.
   */
  async getProperties(props: { siid: number; piid: number }[]): Promise<
    { siid: number; piid: number; value: unknown; code: number }[]
  > {
    return this.call('get_properties', props.map((p) => ({ did: `${p.siid}.${p.piid}`, ...p })));
  }

  async setProperty(siid: number, piid: number, value: unknown): Promise<unknown> {
    return this.call('set_properties', [{ did: `${siid}.${piid}`, siid, piid, value }]);
  }

  async action(siid: number, aiid: number, args: unknown[] = []): Promise<unknown> {
    return this.call('action', [{ did: `${siid}.${aiid}`, siid, aiid, in: args }]);
  }
}

/** Quick reachability + token check without caring what the device is. */
export async function verifyToken(ip: string, token: string): Promise<boolean> {
  try {
    const device = new MiioDevice({ ip, token, timeoutMs: 4000 });
    await device.call('miIO.info');
    return true;
  } catch (err) {
    log.debug(`token check failed for ${ip}: ${(err as Error).message}`);
    return false;
  }
}
