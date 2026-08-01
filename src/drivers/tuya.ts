import { withTuya, TuyaLocalError } from './tuya-local.js';
import { DriverError, requireConfig, type Driver, type DriverContext } from './types.js';

/**
 * Tuya devices over the LAN.
 *
 * Needs three things in driverConfig, all of which the tuya-keys and tuya-match
 * tools produce: the cloud device id, the local key and the protocol version.
 * After that nothing leaves the network.
 */

const HINT = 'הריצו tuya-keys ואז tuya-match כדי למשוך את המפתחות ולהצליב אותם לכתובות.';

function connection(ctx: DriverContext) {
  return {
    deviceId: requireConfig(ctx, 'deviceId', HINT),
    localKey: requireConfig(ctx, 'localKey', HINT),
    version: typeof ctx.config['version'] === 'string' ? ctx.config['version'] : '3.3',
  };
}

async function run<T>(ctx: DriverContext, fn: Parameters<typeof withTuya<T>>[4]): Promise<T> {
  const { deviceId, localKey, version } = connection(ctx);
  try {
    return await withTuya(ctx.ip, deviceId, localKey, version, fn);
  } catch (err) {
    if (err instanceof TuyaLocalError) throw new DriverError(err.message, 502);
    throw err;
  }
}

/**
 * Find the data point that carries on/off.
 *
 * Tuya does not standardise this: switches and sockets use dp 1, while light
 * strips and bulbs use dp 20. Rather than make people configure it, look for
 * whichever of the two is present and boolean.
 */
function powerDp(dps: Record<string, unknown>): string | null {
  for (const key of ['1', '20']) {
    if (typeof dps[key] === 'boolean') return key;
  }
  return null;
}

/** Metering data points, present on smart plugs and breakers. */
function metering(dps: Record<string, unknown>): { current?: number; power?: number; voltage?: number } {
  const num = (k: string) => (typeof dps[k] === 'number' ? (dps[k] as number) : undefined);
  return { current: num('20'), power: num('21'), voltage: num('23') };
}

export const tuyaDriver: Driver = {
  id: 'tuya',
  label: 'Tuya / Smart Life (מקומי)',
  kinds: ['light', 'plug', 'iot', 'sensor'],
  requires: [
    { key: 'deviceId', label: 'מזהה מכשיר', hint: HINT, secret: false },
    { key: 'localKey', label: 'מפתח מקומי', hint: HINT, secret: true },
    { key: 'version', label: 'גרסת פרוטוקול (3.3 / 3.4 / 3.5)', hint: 'מתגלה אוטומטית בסריקה מעמיקה.', secret: false },
  ],

  async probe(ctx) {
    try {
      const status = await run(ctx, (d) => d.status());
      const dp = powerDp(status.dps);
      return {
        ok: true,
        message: dp
          ? `מחובר — כרגע ${status.dps[dp] ? 'דולק' : 'כבוי'} (${Object.keys(status.dps).length} נקודות נתונים)`
          : `מחובר — ${Object.keys(status.dps).length} נקודות נתונים, אך לא זוהתה נקודת הפעלה/כיבוי`,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  },

  async state(ctx) {
    const status = await run(ctx, (d) => d.status());
    const dp = powerDp(status.dps);
    const on = dp ? status.dps[dp] === true : null;
    const meter = metering(status.dps);

    const bits: string[] = [];
    if (on !== null) bits.push(on ? 'דולק' : 'כבוי');
    // Tuya reports power in tenths of a watt.
    if (on && meter.power !== undefined && meter.power > 0) bits.push(`${(meter.power / 10).toFixed(1)} ואט`);

    return {
      online: true,
      summary: bits.join(' · ') || 'מחובר',
      values: {
        on,
        powerDp: dp,
        watts: meter.power !== undefined ? meter.power / 10 : null,
        volts: meter.voltage !== undefined ? meter.voltage / 10 : null,
        milliamps: meter.current ?? null,
        dps: status.dps,
      },
    };
  },

  commands: [
    {
      name: 'on',
      label: 'הדלק',
      run: (ctx) =>
        run(ctx, async (d) => {
          const dp = powerDp((await d.status()).dps);
          if (!dp) throw new DriverError('לא נמצאה נקודת הפעלה/כיבוי במכשיר הזה');
          await d.setDps({ [dp]: true });
          return { ok: true };
        }),
    },
    {
      name: 'off',
      label: 'כבה',
      run: (ctx) =>
        run(ctx, async (d) => {
          const dp = powerDp((await d.status()).dps);
          if (!dp) throw new DriverError('לא נמצאה נקודת הפעלה/כיבוי במכשיר הזה');
          await d.setDps({ [dp]: false });
          return { ok: true };
        }),
    },
    {
      name: 'toggle',
      label: 'הפוך מצב',
      run: (ctx) =>
        run(ctx, async (d) => {
          const dps = (await d.status()).dps;
          const dp = powerDp(dps);
          if (!dp) throw new DriverError('לא נמצאה נקודת הפעלה/כיבוי במכשיר הזה');
          await d.setDps({ [dp]: dps[dp] !== true });
          return { ok: true };
        }),
    },
    {
      name: 'setDps',
      label: 'הגדר נקודת נתונים (מתקדם)',
      params: [
        { key: 'dp', label: 'מספר הנקודה', type: 'string' },
        { key: 'value', label: 'ערך (true/false/מספר/טקסט)', type: 'string' },
      ],
      run: (ctx, args) =>
        run(ctx, async (d) => {
          const dp = String(args['dp'] ?? '').trim();
          if (!dp) throw new DriverError('צריך מספר נקודה');

          const raw = String(args['value'] ?? '').trim();
          const value: unknown =
            raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw;

          await d.setDps({ [dp]: value });
          return { ok: true, dp, value };
        }),
    },
    {
      name: 'dump',
      label: 'קרא את כל נקודות הנתונים',
      run: (ctx) => run(ctx, async (d) => (await d.status()).dps),
    },
  ],
};
