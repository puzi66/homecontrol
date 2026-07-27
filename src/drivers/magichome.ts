import net from 'node:net';
import { DriverError, type Driver, type DriverContext } from './types.js';

/**
 * Magic Home / LEDENET RGB controller on TCP 5577.
 *
 * This is the board inside most unbranded WiFi LED strip controllers and RGB
 * bulbs — sold as Magic Home, LEDENET, Flux LED and a dozen other names. The
 * protocol is plaintext binary with a trailing one-byte sum checksum, and it
 * needs no pairing, key or account.
 */

const PORT = 5577;

const STATUS_QUERY = Buffer.from([0x81, 0x8a, 0x8b, 0x96]);

/** Append the one-byte checksum every command frame ends with. */
function frame(bytes: number[]): Buffer {
  const sum = bytes.reduce((acc, b) => acc + b, 0) & 0xff;
  return Buffer.from([...bytes, sum]);
}

function send(ip: string, payload: Buffer, expectReply: boolean, timeoutMs = 4000): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (err: Error | null, data: Buffer | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(data);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(payload);
      // Commands are fire-and-forget; only the status query answers.
      if (!expectReply) setTimeout(() => finish(null, null), 250);
    });
    socket.on('data', (d) => {
      chunks.push(d);
      if (expectReply && Buffer.concat(chunks).length >= 14) finish(null, Buffer.concat(chunks));
    });
    socket.once('timeout', () =>
      finish(expectReply ? new DriverError(`${ip} did not answer on port ${PORT}`, 502) : null, null),
    );
    socket.once('error', (err) => finish(new DriverError(`${ip}: ${err.message}`, 502), null));

    socket.connect(PORT, ip);
  });
}

export interface MagicHomeStatus {
  deviceType: number;
  on: boolean;
  mode: number;
  red: number;
  green: number;
  blue: number;
  warmWhite: number;
  coldWhite: number;
}

function parseStatus(buf: Buffer): MagicHomeStatus {
  if (buf.length < 14 || buf[0] !== 0x81) {
    throw new DriverError('unexpected reply — this is not a Magic Home controller', 502);
  }
  return {
    deviceType: buf[1]!,
    on: buf[2] === 0x23,
    mode: buf[3]!,
    red: buf[6]!,
    green: buf[7]!,
    blue: buf[8]!,
    warmWhite: buf[9]!,
    coldWhite: buf[11]!,
  };
}

/** Handshake check used by discovery to confirm a 5577 host really is one. */
export async function probeMagicHome(ip: string, timeoutMs = 3000): Promise<MagicHomeStatus | null> {
  try {
    const reply = await send(ip, STATUS_QUERY, true, timeoutMs);
    return reply ? parseStatus(reply) : null;
  } catch {
    return null;
  }
}

async function status(ip: string): Promise<MagicHomeStatus> {
  const reply = await send(ip, STATUS_QUERY, true);
  if (!reply) throw new DriverError(`${ip} gave no status`, 502);
  return parseStatus(reply);
}

function clampByte(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 255) {
    throw new DriverError(`${name} must be between 0 and 255`);
  }
  return Math.round(n);
}

export const magicHomeDriver: Driver = {
  id: 'magichome',
  label: 'בקר תאורת Magic Home / LEDENET',
  kinds: ['light'],
  requires: [],

  async probe(ctx) {
    const found = await probeMagicHome(ctx.ip);
    if (!found) return { ok: false, message: `אין בקר Magic Home שעונה ב-${ctx.ip}:${PORT}` };
    return {
      ok: true,
      message: `בקר מסוג 0x${found.deviceType.toString(16)}, כרגע ${found.on ? 'דולק' : 'כבוי'}`,
    };
  },

  async state(ctx) {
    const s = await status(ctx.ip);
    const colour = `rgb(${s.red}, ${s.green}, ${s.blue})`;
    return {
      online: true,
      summary: s.on ? `דולק · ${colour}` : 'כבוי',
      values: { ...s, colour },
    };
  },

  commands: [
    {
      name: 'on',
      label: 'הדלק',
      run: (ctx: DriverContext) => send(ctx.ip, frame([0x71, 0x23, 0x0f]), false),
    },
    {
      name: 'off',
      label: 'כבה',
      run: (ctx) => send(ctx.ip, frame([0x71, 0x24, 0x0f]), false),
    },
    {
      name: 'toggle',
      label: 'הפוך מצב',
      async run(ctx) {
        const s = await status(ctx.ip);
        return send(ctx.ip, frame([0x71, s.on ? 0x24 : 0x23, 0x0f]), false);
      },
    },
    {
      name: 'setColor',
      label: 'הגדר צבע RGB',
      params: [
        { key: 'red', label: 'אדום 0-255', type: 'number' },
        { key: 'green', label: 'ירוק 0-255', type: 'number' },
        { key: 'blue', label: 'כחול 0-255', type: 'number' },
      ],
      run(ctx, args) {
        const r = clampByte(args['red'], 'red');
        const g = clampByte(args['green'], 'green');
        const b = clampByte(args['blue'], 'blue');
        // 0xf0 selects the RGB channels; 0x0f is the "local, persist" flag.
        return send(ctx.ip, frame([0x31, r, g, b, 0x00, 0xf0, 0x0f]), false);
      },
    },
    {
      name: 'setWhite',
      label: 'הגדר לבן',
      params: [{ key: 'level', label: 'לבן חם 0-255', type: 'number' }],
      run(ctx, args) {
        const w = clampByte(args['level'], 'level');
        // 0x0f here selects the white channel instead of RGB.
        return send(ctx.ip, frame([0x31, 0x00, 0x00, 0x00, w, 0x0f, 0x0f]), false);
      },
    },
  ],
};
