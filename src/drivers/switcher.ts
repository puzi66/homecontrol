import net from 'node:net';
import { discoverSwitcher, readSwitcherState } from '../discovery/switcher.js';
import { logger } from '../logger.js';
import { DriverError, type Driver, type DriverContext } from './types.js';

const log = logger('switcher');

/**
 * Switcher water heaters, plugs and Type 1 devices, over the local network.
 *
 * Reading state needs nothing at all: the device broadcasts it on UDP 20002
 * every few seconds. Control is a short TCP conversation on port 9957 — log in,
 * receive a session id, send the command with that session.
 *
 * The packet layouts and the two-stage CRC below follow the aioswitcher project
 * (Apache-2.0), which is the reference implementation for this undocumented
 * protocol. They were transcribed from its source rather than reconstructed
 * from memory: a wrong byte here means a silent failure against a device that
 * heats water.
 */

const CONTROL_PORT = 9957;

const P_SESSION = '00000000';
const PAD_72_ZEROS = '0'.repeat(72);
const NO_TIMER = '00000000';

/** "{session}340001...{timestamp}...f0fe" — the common body of every request. */
const REQUEST_BODY = '340001000000000000000000{timestamp}00000000000000000000f0fe';

/**
 * CRC-CCITT, matching Python's binascii.crc_hqx. Note the initial value is
 * 0x1021 — the same constant as the polynomial, which looks like a bug in the
 * reference implementation but is load-bearing: the devices expect it.
 */
function crcHqx(data: Buffer, init: number): number {
  let crc = init & 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Take a 16-bit CRC and render it the way the protocol wants: low byte first. */
function crcToHexSwapped(crc: number): string {
  const hex = crc.toString(16).padStart(8, '0'); // as a big-endian uint32
  return hex.slice(6, 8) + hex.slice(4, 6);
}

/**
 * Write the packet's own length into bytes 2-3.
 *
 * The length counts the packet plus the four signature bytes about to be
 * appended, and is written as hex then padded on the *right* — so 0x52 becomes
 * "5200", not "0052".
 */
function setMessageLength(hexPacket: string): string {
  const byteLength = (hexPacket.length + 8) / 2;
  const length = byteLength.toString(16).padEnd(4, '0');
  return `fef0${length}${hexPacket.slice(8)}`;
}

/** Append the two CRC bytes and the two key-CRC bytes the device checks. */
function signPacket(hexPacket: string): string {
  const packetCrc = crcToHexSwapped(crcHqx(Buffer.from(hexPacket, 'hex'), 0x1021));
  const keyCrc = crcToHexSwapped(crcHqx(Buffer.from(packetCrc + '30'.repeat(32), 'hex'), 0x1021));
  return hexPacket + packetCrc + keyCrc;
}

/** Current unix time as a little-endian uint32, hex. */
function timestampHex(): string {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(Math.round(Date.now() / 1000), 0);
  return buf.toString('hex');
}

function body(session: string, timestamp: string): string {
  return session + REQUEST_BODY.replace('{timestamp}', timestamp);
}

/** One request/response exchange on an open socket. */
function exchange(socket: net.Socket, hexPacket: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, data?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      if (err) reject(err);
      else resolve(data!);
    };

    const onData = (chunk: Buffer) => finish(null, chunk);
    const timer = setTimeout(() => finish(new DriverError('המכשיר לא ענה בזמן', 504)), timeoutMs);

    socket.on('data', onData);
    socket.write(Buffer.from(signPacket(setMessageLength(hexPacket)), 'hex'), (err) => {
      if (err) finish(err);
    });
  });
}

/**
 * Open a socket, log in and hand the session to `run`. Always closes.
 *
 * `deviceKey` is "00" for the classic Type 1 range; newer units that need a
 * real key expose it through the vendor app.
 */
async function withSession<T>(
  ip: string,
  deviceKey: string,
  run: (socket: net.Socket, session: string, timestamp: string) => Promise<T>,
  timeoutMs = 8000,
): Promise<T> {
  const socket = new net.Socket();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new DriverError(`אין חיבור ל-${ip}:${CONTROL_PORT}`, 502));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new DriverError(`${ip}: ${err.message}`, 502));
    });
    socket.connect(CONTROL_PORT, ip);
  });

  try {
    const timestamp = timestampHex();
    const loginPacket =
      'fef052000232a100' + body(P_SESSION, timestamp) + deviceKey + PAD_72_ZEROS + '00';

    const reply = await exchange(socket, loginPacket, timeoutMs);
    if (reply.length < 12) throw new DriverError('תשובת התחברות קצרה מדי', 502);

    // The session id the device assigns us: bytes 8-11 of the reply.
    const session = reply.subarray(8, 12).toString('hex');
    log.debug(`logged in to ${ip}, session ${session}`);

    return await run(socket, session, timestamp);
  } finally {
    socket.destroy();
  }
}

function requireDeviceId(ctx: DriverContext): string {
  const raw = ctx.config['deviceId'];
  const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{6}$/.test(id)) {
    throw new DriverError(
      `חסר מזהה מכשיר עבור ${ctx.device.name}. הוא מתגלה אוטומטית בסריקה, או שאפשר להזין 6 תווים הקסדצימליים ידנית.`,
      412,
    );
  }
  return id;
}

const deviceKeyOf = (ctx: DriverContext) =>
  typeof ctx.config['deviceKey'] === 'string' && ctx.config['deviceKey'] ? ctx.config['deviceKey'] : '00';

/** Send a power command. `on` closes the relay; minutes adds a shutdown timer. */
async function setPower(ctx: DriverContext, on: boolean, minutes = 0): Promise<void> {
  const deviceId = requireDeviceId(ctx);
  const timer =
    minutes > 0
      ? (() => {
          const b = Buffer.alloc(4);
          b.writeUInt32LE(minutes * 60, 0);
          return b.toString('hex');
        })()
      : NO_TIMER;

  await withSession(ctx.ip, deviceKeyOf(ctx), async (socket, session, timestamp) => {
    const packet =
      'fef05d0002320102' +
      body(session, timestamp) +
      deviceId +
      PAD_72_ZEROS +
      '000106000' +
      (on ? '1' : '0') +
      '00' +
      timer;
    await exchange(socket, packet, 8000);
  });

  log.info(`${ctx.device.name}: turned ${on ? 'on' : 'off'}`);
}

export const switcherDriver: Driver = {
  id: 'switcher',
  label: 'Switcher — דוד / שקע',
  kinds: ['plug', 'iot'],
  requires: [
    {
      key: 'deviceId',
      label: 'מזהה מכשיר',
      hint: '6 תווים הקסדצימליים. מתגלה אוטומטית מהשידור של המכשיר.',
      secret: false,
    },
  ],

  async probe(ctx) {
    const seen = await readSwitcherState(ctx.ip);
    if (!seen) {
      return {
        ok: false,
        message: 'לא נשמע שידור מהמכשיר. ודאו שהוא באותה רשת ושפורט UDP 20002 לא חסום.',
      };
    }
    const configured = typeof ctx.config['deviceId'] === 'string' && ctx.config['deviceId'];
    return {
      ok: true,
      message: configured
        ? `${seen.name} — כרגע ${seen.on ? 'פועל' : 'כבוי'}`
        : `${seen.name} נמצא. מזהה המכשיר הוא ${seen.deviceId} — שמרו אותו כדי לאפשר שליטה.`,
    };
  },

  async state(ctx) {
    const seen = await readSwitcherState(ctx.ip);
    if (!seen) throw new DriverError('לא התקבל שידור מהמכשיר', 504);

    const bits = [seen.on ? 'פועל' : 'כבוי'];
    if (seen.on && seen.watts > 0) bits.push(`${seen.watts} ואט`);
    if (seen.remainingSeconds > 0) bits.push(`נותרו ${Math.round(seen.remainingSeconds / 60)} דק׳`);

    return {
      online: true,
      summary: bits.join(' · '),
      values: {
        on: seen.on,
        watts: seen.watts,
        remainingMinutes: Math.round(seen.remainingSeconds / 60),
        autoShutdownMinutes: Math.round(seen.autoShutdownSeconds / 60),
        deviceId: seen.deviceId,
        name: seen.name,
      },
    };
  },

  commands: [
    {
      name: 'on',
      label: 'הדלק',
      run: async (ctx) => {
        await setPower(ctx, true);
        return { ok: true };
      },
    },
    {
      name: 'off',
      label: 'כבה',
      run: async (ctx) => {
        await setPower(ctx, false);
        return { ok: true };
      },
    },
    {
      name: 'onForMinutes',
      label: 'הדלק לזמן מוגבל',
      params: [{ key: 'minutes', label: 'דקות', type: 'number' }],
      run: async (ctx, args) => {
        const minutes = Number(args['minutes']);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
          throw new DriverError('הזמן חייב להיות בין 1 ל-180 דקות');
        }
        await setPower(ctx, true, minutes);
        return { ok: true, minutes };
      },
    },
    {
      name: 'diagnose',
      label: 'בדוק את ערוץ השליטה (בלי לשנות מצב)',
      /**
       * Logs in and issues the protocol's read-only get-state request.
       *
       * This exercises the whole control path — connect, log in, receive a
       * session, sign and send a request — without touching the relay, which
       * matters when the device is a water heater. If this succeeds, `on` and
       * `off` will work.
       */
      run: async (ctx) => {
        const deviceId = requireDeviceId(ctx);
        return withSession(ctx.ip, deviceKeyOf(ctx), async (socket, session, timestamp) => {
          const packet = 'fef0300002320103' + body(session, timestamp) + deviceId + '00';
          const reply = await exchange(socket, packet, 8000);
          return {
            ok: reply.length > 0,
            session,
            replyBytes: reply.length,
            reply: reply.subarray(0, 24).toString('hex'),
            message: `ערוץ השליטה עובד — התחברות הצליחה והמכשיר ענה ${reply.length} בייטים`,
          };
        });
      },
    },
    {
      name: 'identify',
      label: 'קרא מזהה מכשיר מהשידור',
      run: async (ctx) => {
        const seen = await readSwitcherState(ctx.ip);
        if (!seen) throw new DriverError('לא התקבל שידור מהמכשיר', 504);
        // Persisted into driverConfig by the command runner.
        return { config: { deviceId: seen.deviceId }, message: `מזהה ${seen.deviceId} נשמר` };
      },
    },
  ],
};

export { discoverSwitcher };
