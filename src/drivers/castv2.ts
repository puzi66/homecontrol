import tls from 'node:tls';
import { logger } from '../logger.js';

const log = logger('castv2');

/**
 * The CASTV2 protocol, spoken by Chromecasts, Nest displays, Google speakers
 * and Android TV boxes on TCP 8009.
 *
 * Frames are a 4-byte big-endian length followed by a protobuf `CastMessage`.
 * That message has six fields we care about, so it is encoded by hand rather
 * than pulling in a protobuf runtime:
 *
 *   1 protocol_version  varint
 *   2 source_id         string
 *   3 destination_id    string
 *   4 namespace         string
 *   5 payload_type      varint
 *   6 payload_utf8      string
 *
 * The transport is TLS with a self-signed device certificate, so verification
 * is off — the connection is to a fixed address on the local network, and there
 * is no certificate authority in the picture to check against.
 */

const PORT = 8009;

export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
} as const;

export class CastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CastError';
  }
}

// --- protobuf, the small part of it we need ------------------------------

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let n = value;
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 1;
  let pos = at;
  for (;;) {
    const byte = buf[pos++]!;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) break;
    shift *= 128;
  }
  return { value, next: pos };
}

const stringField = (fieldTag: number, text: string): Buffer => {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([fieldTag]), varint(body.length), body]);
};

export interface CastMessage {
  sourceId: string;
  destinationId: string;
  namespace: string;
  payload: string;
}

function encodeMessage(m: CastMessage): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x08]), varint(0),            // protocol_version = CASTV2_1_0
    stringField(0x12, m.sourceId),
    stringField(0x1a, m.destinationId),
    stringField(0x22, m.namespace),
    Buffer.from([0x28]), varint(0),            // payload_type = STRING
    stringField(0x32, m.payload),
  ]);

  const framed = Buffer.alloc(4);
  framed.writeUInt32BE(body.length, 0);
  return Buffer.concat([framed, body]);
}

function decodeMessage(buf: Buffer): CastMessage | null {
  const out: CastMessage = { sourceId: '', destinationId: '', namespace: '', payload: '' };
  let at = 0;

  while (at < buf.length) {
    const tag = buf[at++]!;
    const field = tag >> 3;
    const wire = tag & 0x07;

    if (wire === 0) {
      at = readVarint(buf, at).next;
      continue;
    }
    if (wire !== 2) return null; // nothing else should appear

    const { value: len, next } = readVarint(buf, at);
    const value = buf.subarray(next, next + len);
    at = next + len;

    if (field === 2) out.sourceId = value.toString('utf8');
    else if (field === 3) out.destinationId = value.toString('utf8');
    else if (field === 4) out.namespace = value.toString('utf8');
    else if (field === 6) out.payload = value.toString('utf8');
  }

  return out;
}

// --- client --------------------------------------------------------------

export interface ReceiverStatus {
  volumeLevel: number | null;
  muted: boolean | null;
  /** The running app, if any. */
  appId: string | null;
  displayName: string | null;
  statusText: string | null;
  /** Channel to address for media control. */
  transportId: string | null;
}

export interface MediaStatus {
  playerState: string | null;
  title: string | null;
  subtitle: string | null;
  currentTime: number | null;
  duration: number | null;
  mediaSessionId: number | null;
}

/**
 * One short-lived connection to one device.
 *
 * Deliberately not kept open: a Cast device tolerates a sender connecting,
 * asking and leaving, and holding sockets to seven devices in order to poll
 * them every twenty seconds would be worse than reconnecting.
 */
export class CastClient {
  #socket: tls.TLSSocket | null = null;
  #buffer = Buffer.alloc(0);
  #requestId = 1;
  #handlers = new Set<(m: CastMessage) => void>();
  readonly #sourceId = `sender-${Math.floor(Math.random() * 1e6)}`;

  constructor(
    private readonly ip: string,
    private readonly timeoutMs = 6000,
  ) {}

  async connect(): Promise<void> {
    this.#socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect(
        { host: this.ip, port: PORT, rejectUnauthorized: false, timeout: this.timeoutMs },
        () => resolve(socket),
      );
      socket.once('error', (err) => reject(new CastError(`${this.ip}: ${err.message}`)));
      socket.once('timeout', () => {
        socket.destroy();
        reject(new CastError(`${this.ip}: connection timed out`));
      });
    });

    this.#socket.on('data', (chunk) => this.#onData(chunk));
    this.#socket.on('error', () => {});

    // Every channel must be opened before it will accept anything else.
    this.send(NS.connection, 'receiver-0', { type: 'CONNECT' });
  }

  close(): void {
    try {
      if (this.#socket) this.send(NS.connection, 'receiver-0', { type: 'CLOSE' });
    } catch {
      /* already gone */
    }
    this.#socket?.destroy();
    this.#socket = null;
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (this.#buffer.length < 4 + length) return;

      const frame = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);

      const message = decodeMessage(frame);
      if (!message) continue;

      // Keepalive: the device drops senders that ignore it.
      if (message.namespace === NS.heartbeat && message.payload.includes('PING')) {
        this.send(NS.heartbeat, message.sourceId, { type: 'PONG' });
        continue;
      }

      for (const handler of this.#handlers) handler(message);
    }
  }

  send(namespace: string, destinationId: string, payload: Record<string, unknown>): void {
    if (!this.#socket) throw new CastError('not connected');
    this.#socket.write(
      encodeMessage({
        sourceId: this.#sourceId,
        destinationId,
        namespace,
        payload: JSON.stringify(payload),
      }),
    );
  }

  /** Send a request and wait for the reply carrying the same requestId. */
  request(
    namespace: string,
    destinationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requestId = this.#requestId++;

    return new Promise((resolve, reject) => {
      const handler = (message: CastMessage) => {
        if (message.namespace !== namespace) return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(message.payload) as Record<string, unknown>;
        } catch {
          return;
        }
        if (parsed['requestId'] !== requestId) return;
        cleanup();
        resolve(parsed);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new CastError(`${this.ip}: no reply to ${String(payload['type'])}`));
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.#handlers.delete(handler);
      };

      this.#handlers.add(handler);
      try {
        this.send(namespace, destinationId, { ...payload, requestId });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  async receiverStatus(): Promise<ReceiverStatus> {
    const reply = await this.request(NS.receiver, 'receiver-0', { type: 'GET_STATUS' });
    const status = (reply['status'] ?? {}) as Record<string, unknown>;
    const volume = (status['volume'] ?? {}) as Record<string, unknown>;
    const app = ((status['applications'] as Record<string, unknown>[] | undefined) ?? [])[0];

    return {
      volumeLevel: typeof volume['level'] === 'number' ? volume['level'] : null,
      muted: typeof volume['muted'] === 'boolean' ? volume['muted'] : null,
      appId: (app?.['appId'] as string) ?? null,
      displayName: (app?.['displayName'] as string) ?? null,
      statusText: (app?.['statusText'] as string) ?? null,
      transportId: (app?.['transportId'] as string) ?? null,
    };
  }

  /** Media details, when something is loaded. Needs the app's transportId. */
  async mediaStatus(transportId: string): Promise<MediaStatus | null> {
    // The media channel is a separate virtual connection.
    this.send(NS.connection, transportId, { type: 'CONNECT' });

    let reply: Record<string, unknown>;
    try {
      reply = await this.request(NS.media, transportId, { type: 'GET_STATUS' });
    } catch {
      return null; // app is running but has no media session
    }

    const entry = ((reply['status'] as Record<string, unknown>[] | undefined) ?? [])[0];
    if (!entry) return null;

    const media = (entry['media'] ?? {}) as Record<string, unknown>;
    const meta = (media['metadata'] ?? {}) as Record<string, unknown>;

    return {
      playerState: (entry['playerState'] as string) ?? null,
      title: (meta['title'] as string) ?? null,
      subtitle: (meta['subtitle'] as string) ?? (meta['artist'] as string) ?? null,
      currentTime: typeof entry['currentTime'] === 'number' ? entry['currentTime'] : null,
      duration: typeof media['duration'] === 'number' ? media['duration'] : null,
      mediaSessionId: typeof entry['mediaSessionId'] === 'number' ? entry['mediaSessionId'] : null,
    };
  }

  async setVolume(level: number): Promise<void> {
    await this.request(NS.receiver, 'receiver-0', {
      type: 'SET_VOLUME',
      volume: { level: Math.max(0, Math.min(1, level)) },
    });
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.request(NS.receiver, 'receiver-0', { type: 'SET_VOLUME', volume: { muted } });
  }

  async stopApp(sessionId: string): Promise<void> {
    await this.request(NS.receiver, 'receiver-0', { type: 'STOP', sessionId });
  }

  /** PLAY, PAUSE or STOP against the running media session. */
  async mediaCommand(transportId: string, mediaSessionId: number, type: string): Promise<void> {
    this.send(NS.connection, transportId, { type: 'CONNECT' });
    await this.request(NS.media, transportId, { type, mediaSessionId });
  }
}

/** Connect, run something, always disconnect. */
export async function withCast<T>(ip: string, run: (client: CastClient) => Promise<T>): Promise<T> {
  const client = new CastClient(ip);
  await client.connect();
  try {
    return await run(client);
  } finally {
    client.close();
    log.debug(`${ip}: closed`);
  }
}
