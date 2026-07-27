import { MiioDevice, MiioError } from './miio-protocol.js';
import { DriverError, requireConfig, type Driver, type DriverContext } from './types.js';

/**
 * MOVA / Dreame robot vacuum over the local miio protocol.
 *
 * MOVA is Dreame's sub-brand and speaks the same MIoT property model. Two
 * things are worth knowing before using this driver:
 *
 * 1. It needs the 32-hex-character device token. Recent firmware stops
 *    publishing the token in the handshake once the robot has been paired to
 *    the app, so it has to be extracted from the vendor cloud or an app backup
 *    and then stored in driverConfig.token.
 *
 * 2. The siid/piid numbers below are the map Dreame uses across most current
 *    models, but they do move between model generations. Run the `dump`
 *    command once a token is in place to see what this particular robot
 *    actually exposes, and override any that differ via driverConfig.map.
 */

interface PropertyMap {
  status: [number, number];
  fault: [number, number];
  battery: [number, number];
  charging: [number, number];
  fanSpeed: [number, number];
  waterLevel: [number, number];
  cleaningTime: [number, number];
  cleaningArea: [number, number];
}

const DEFAULT_MAP: PropertyMap = {
  status: [2, 1],
  fault: [2, 2],
  battery: [3, 1],
  charging: [3, 2],
  fanSpeed: [4, 4],
  waterLevel: [4, 5],
  cleaningTime: [4, 2],
  cleaningArea: [4, 3],
};

const ACTIONS = {
  start: [2, 1],
  stop: [2, 2],
  dock: [3, 1],
  locate: [7, 1],
} as const;

/** Dreame's status enum. Values beyond this are reported as the raw number. */
const STATUS_LABELS: Record<number, string> = {
  0: 'מטאטא',
  1: 'ממתין',
  2: 'מושהה',
  3: 'תקלה',
  4: 'חוזר לעגינה',
  5: 'בטעינה',
  6: 'שוטף',
  7: 'מייבש',
  8: 'שוטף מטליות',
  9: 'חוזר לשטיפה',
  10: 'בונה מפה',
  11: 'מטאטא ושוטף',
  12: 'טעינה הושלמה',
  13: 'מעדכן קושחה',
};

const TOKEN_HINT = 'צריך לחלץ את הטוקן (32 תווים) מאפליקציית MOVA Home / Dreame ולהזין אותו כאן.';

function resolveMap(ctx: DriverContext): PropertyMap {
  const override = ctx.config['map'];
  if (!override || typeof override !== 'object') return DEFAULT_MAP;
  return { ...DEFAULT_MAP, ...(override as Partial<PropertyMap>) };
}

function connect(ctx: DriverContext): MiioDevice {
  const token = requireConfig(ctx, 'token', TOKEN_HINT);
  try {
    return new MiioDevice({ ip: ctx.ip, token });
  } catch (err) {
    throw new DriverError((err as Error).message, 400);
  }
}

/** Turn a driver call into a DriverError so the API returns something useful. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MiioError) throw new DriverError(err.message, 502);
    throw err;
  }
}

export const movaDriver: Driver = {
  id: 'mova',
  label: 'שואב MOVA / Dreame',
  kinds: ['vacuum'],
  requires: [
    { key: 'token', label: 'טוקן המכשיר', hint: TOKEN_HINT, secret: true },
  ],

  async probe(ctx) {
    const { probeMiio } = await import('../discovery/miio.js');
    const hello = await probeMiio(ctx.ip, 4000);

    if (!hello) return { ok: false, message: 'השואב לא ענה ל-handshake של miio' };
    if (typeof ctx.config['token'] !== 'string' || !ctx.config['token']) {
      return { ok: false, message: `נגיש (מזהה ${hello.deviceId}) אבל אין טוקן. ${TOKEN_HINT}` };
    }

    try {
      const device = connect(ctx);
      const info = await device.call<{ model?: string; fw_ver?: string }>('miIO.info');
      return { ok: true, message: `מחובר ל-${info.model ?? 'שואב'} (קושחה ${info.fw_ver ?? '?'})` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  },

  async state(ctx) {
    const device = connect(ctx);
    const map = resolveMap(ctx);

    const wanted = Object.entries(map) as [keyof PropertyMap, [number, number]][];
    const results = await guard(() =>
      device.getProperties(wanted.map(([, [siid, piid]]) => ({ siid, piid }))),
    );

    const values: Record<string, unknown> = {};
    wanted.forEach(([name], i) => {
      const entry = results[i];
      // A non-zero code means this model does not have that property.
      values[name] = entry && entry.code === 0 ? entry.value : null;
    });

    const statusRaw = values['status'];
    const status = typeof statusRaw === 'number' ? (STATUS_LABELS[statusRaw] ?? `מצב ${statusRaw}`) : 'לא ידוע';
    const battery = typeof values['battery'] === 'number' ? values['battery'] : null;

    return {
      online: true,
      summary: `${status}${battery !== null ? ` · ${battery}%` : ''}`,
      values: { ...values, statusLabel: status },
    };
  },

  commands: [
    {
      name: 'start',
      label: 'התחל ניקוי',
      run: (ctx) => guard(() => connect(ctx).action(...ACTIONS.start)),
    },
    {
      name: 'stop',
      label: 'עצור',
      run: (ctx) => guard(() => connect(ctx).action(...ACTIONS.stop)),
    },
    {
      name: 'dock',
      label: 'חזור לעגינה',
      run: (ctx) => guard(() => connect(ctx).action(...ACTIONS.dock)),
    },
    {
      name: 'locate',
      label: 'מצא את הרובוט (צפצוף)',
      run: (ctx) => guard(() => connect(ctx).action(...ACTIONS.locate)),
    },
    {
      name: 'setFanSpeed',
      label: 'עוצמת שאיבה',
      params: [{ key: 'level', label: 'דרגה 0-3', type: 'number' }],
      async run(ctx, args) {
        const level = Number(args['level']);
        if (!Number.isInteger(level) || level < 0 || level > 3) {
          throw new DriverError('level must be an integer between 0 and 3');
        }
        const [siid, piid] = resolveMap(ctx).fanSpeed;
        return guard(() => connect(ctx).setProperty(siid, piid, level));
      },
    },
    {
      name: 'dump',
      label: 'סרוק מה הדגם הזה חושף (לתיקון מפת המאפיינים)',
      async run(ctx) {
        const device = connect(ctx);
        const info = await guard(() => device.call<Record<string, unknown>>('miIO.info'));

        // Walk the low service/property ids and report whatever answers, so the
        // real map for this specific model can be read off the result.
        const probes: { siid: number; piid: number }[] = [];
        for (let siid = 1; siid <= 9; siid++) {
          for (let piid = 1; piid <= 8; piid++) probes.push({ siid, piid });
        }

        const found: Record<string, unknown> = {};
        // Chunked: asking for 72 properties in one packet overflows the MTU.
        for (let i = 0; i < probes.length; i += 12) {
          const chunk = probes.slice(i, i + 12);
          try {
            const results = await device.getProperties(chunk);
            results.forEach((r, idx) => {
              const p = chunk[idx]!;
              if (r?.code === 0) found[`${p.siid}.${p.piid}`] = r.value;
            });
          } catch {
            // A chunk containing an unsupported property can fail wholesale;
            // skip it rather than aborting the dump.
          }
        }

        return { info, properties: found, currentMap: resolveMap(ctx) };
      },
    },
  ],
};
