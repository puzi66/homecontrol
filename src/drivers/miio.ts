import { probeMiio } from '../discovery/miio.js';
import { MiioDevice, MiioError } from './miio-protocol.js';
import { DriverError, requireConfig, type Driver, type DriverContext } from './types.js';

/**
 * Generic Xiaomi-ecosystem device over miio.
 *
 * The vacuum driver knows a specific property map. This one knows none, on
 * purpose: cameras, sensors, plugs, purifiers and gateways all speak miio with
 * completely different property layouts, and guessing at them is how a camera
 * ends up being driven as a robot.
 *
 * So it exposes the protocol itself — read the device's own description, sweep
 * its properties, set one, invoke an action. Point it at something, run `dump`,
 * and the result tells you what that model actually offers.
 */

const TOKEN_HINT =
  'צריך את הטוקן (32 תווים הקסדצימליים). למכשיר שרשום ב-Xiaomi Home אפשר לחלץ אותו בכלי הרשמי לחילוץ טוקנים.';

function connect(ctx: DriverContext): MiioDevice {
  const token = requireConfig(ctx, 'token', TOKEN_HINT);
  try {
    return new MiioDevice({ ip: ctx.ip, token });
  } catch (err) {
    throw new DriverError((err as Error).message, 400);
  }
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MiioError) throw new DriverError(err.message, 502);
    throw err;
  }
}

export const miioDriver: Driver = {
  id: 'miio',
  label: 'Xiaomi miio (כללי)',
  kinds: ['camera', 'sensor', 'plug', 'light', 'iot', 'thermostat'],
  requires: [{ key: 'token', label: 'טוקן המכשיר', hint: TOKEN_HINT, secret: true }],

  async probe(ctx) {
    const hello = await probeMiio(ctx.ip, 4000);
    if (!hello) return { ok: false, message: 'המכשיר לא ענה ל-handshake של miio' };

    if (typeof ctx.config['token'] !== 'string' || !ctx.config['token']) {
      return {
        ok: false,
        message: `נגיש (מזהה ${hello.deviceId}) אבל אין טוקן. ${TOKEN_HINT}`,
      };
    }

    try {
      const info = await guard(() =>
        connect(ctx).call<{ model?: string; fw_ver?: string }>('miIO.info'),
      );
      return { ok: true, message: `מחובר — ${info.model ?? 'לא ידוע'} (קושחה ${info.fw_ver ?? '?'})` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  },

  async state(ctx) {
    const info = await guard(() =>
      connect(ctx).call<Record<string, unknown>>('miIO.info'),
    );

    const model = typeof info['model'] === 'string' ? info['model'] : null;
    const life = typeof info['life'] === 'number' ? info['life'] : null;

    return {
      online: true,
      summary: [model, life ? `פעיל ${Math.round(life / 3600)} שעות` : null]
        .filter(Boolean)
        .join(' · ') || 'מחובר',
      values: {
        model,
        firmware: info['fw_ver'] ?? null,
        hardware: info['hw_ver'] ?? null,
        uptimeSeconds: life,
        wifiSignal: (info['ap'] as Record<string, unknown> | undefined)?.['rssi'] ?? null,
        raw: info,
      },
    };
  },

  commands: [
    {
      name: 'info',
      label: 'פרטי המכשיר',
      run: (ctx) => guard(() => connect(ctx).call<Record<string, unknown>>('miIO.info')),
    },
    {
      name: 'dump',
      label: 'סרוק אילו מאפיינים הדגם הזה חושף',
      /**
       * Walk the low service and property ids and report whatever answers.
       * This is how you learn a model's layout without a spec for it.
       */
      run: (ctx) =>
        guard(async () => {
          const device = connect(ctx);
          const probes: { siid: number; piid: number }[] = [];
          for (let siid = 1; siid <= 9; siid++) {
            for (let piid = 1; piid <= 8; piid++) probes.push({ siid, piid });
          }

          const found: Record<string, unknown> = {};
          // Chunked: one packet cannot carry seventy-odd property reads.
          for (let i = 0; i < probes.length; i += 12) {
            const chunk = probes.slice(i, i + 12);
            try {
              const results = await device.getProperties(chunk);
              results.forEach((r, idx) => {
                const p = chunk[idx]!;
                if (r?.code === 0) found[`${p.siid}.${p.piid}`] = r.value;
              });
            } catch {
              // A chunk containing an unsupported property fails wholesale.
            }
          }
          return found;
        }),
    },
    {
      name: 'getProperty',
      label: 'קרא מאפיין',
      params: [
        { key: 'siid', label: 'siid', type: 'number' },
        { key: 'piid', label: 'piid', type: 'number' },
      ],
      run: (ctx, args) =>
        guard(async () => {
          const siid = Number(args['siid']);
          const piid = Number(args['piid']);
          if (!Number.isInteger(siid) || !Number.isInteger(piid)) {
            throw new DriverError('siid ו-piid חייבים להיות מספרים שלמים');
          }
          return (await connect(ctx).getProperties([{ siid, piid }]))[0];
        }),
    },
    {
      name: 'setProperty',
      label: 'הגדר מאפיין',
      params: [
        { key: 'siid', label: 'siid', type: 'number' },
        { key: 'piid', label: 'piid', type: 'number' },
        { key: 'value', label: 'ערך (true/false/מספר/טקסט)', type: 'string' },
      ],
      run: (ctx, args) =>
        guard(async () => {
          const siid = Number(args['siid']);
          const piid = Number(args['piid']);
          if (!Number.isInteger(siid) || !Number.isInteger(piid)) {
            throw new DriverError('siid ו-piid חייבים להיות מספרים שלמים');
          }
          const raw = String(args['value'] ?? '').trim();
          const value: unknown =
            raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw;

          return connect(ctx).setProperty(siid, piid, value);
        }),
    },
    {
      name: 'call',
      label: 'קרא למתודה (מתקדם)',
      params: [
        { key: 'method', label: 'שם המתודה', type: 'string' },
        { key: 'params', label: 'פרמטרים כ-JSON', type: 'string' },
      ],
      run: (ctx, args) =>
        guard(async () => {
          const method = String(args['method'] ?? '').trim();
          if (!method) throw new DriverError('צריך שם מתודה');

          let params: unknown[] = [];
          const raw = String(args['params'] ?? '').trim();
          if (raw) {
            try {
              const parsed: unknown = JSON.parse(raw);
              params = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              throw new DriverError('הפרמטרים חייבים להיות JSON תקין');
            }
          }
          return connect(ctx).call(method, params);
        }),
    },
  ],
};
