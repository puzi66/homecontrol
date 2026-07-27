import { logger } from '../logger.js';
import { DriverError, requireConfig, type Driver, type DriverContext } from './types.js';

const log = logger('hue');

/**
 * Philips Hue bridge over its local HTTP API.
 *
 * Everything here is unauthenticated LAN traffic to the bridge itself — no
 * Hue cloud account is involved. The one setup step is pressing the physical
 * link button and calling the `pair` command within 30 seconds.
 */

interface HueLight {
  name: string;
  state: { on: boolean; bri?: number; reachable: boolean };
  type: string;
}

async function hueGet<T>(ip: string, path: string): Promise<T> {
  const res = await fetch(`http://${ip}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new DriverError(`Hue bridge returned ${res.status}`, 502);
  return (await res.json()) as T;
}

async function huePut(ip: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://${ip}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new DriverError(`Hue bridge returned ${res.status}`, 502);
  return res.json();
}

const HINT = 'לחצו על הכפתור העגול בגשר ואז הריצו את הפקודה pair בתוך 30 שניות.';

export const hueDriver: Driver = {
  id: 'hue',
  label: 'גשר Philips Hue',
  kinds: ['hub', 'light'],
  requires: [
    { key: 'username', label: 'שם משתמש API', hint: HINT, secret: true },
  ],

  async probe(ctx) {
    try {
      const config = await hueGet<{ name?: string; swversion?: string }>(ctx.ip, '/api/0/config');
      const paired = typeof ctx.config['username'] === 'string' && ctx.config['username'];
      return {
        ok: true,
        message: paired
          ? `${config.name ?? 'גשר Hue'} נגיש ומקושר`
          : `${config.name ?? 'גשר Hue'} נגיש אבל עוד לא מקושר. ${HINT}`,
      };
    } catch (err) {
      return { ok: false, message: `אין גישה לגשר: ${(err as Error).message}` };
    }
  },

  async state(ctx) {
    const username = requireConfig(ctx, 'username', HINT);
    const lights = await hueGet<Record<string, HueLight>>(ctx.ip, `/api/${username}/lights`);

    const entries = Object.entries(lights);
    const on = entries.filter(([, l]) => l.state.on).length;
    const unreachable = entries.filter(([, l]) => !l.state.reachable).length;

    return {
      online: true,
      summary: `${on} מתוך ${entries.length} נורות דולקות${unreachable ? ` · ${unreachable} לא נגישות` : ''}`,
      values: {
        lightCount: entries.length,
        onCount: on,
        lights: entries.map(([id, l]) => ({
          id,
          name: l.name,
          on: l.state.on,
          brightness: l.state.bri ?? null,
          reachable: l.state.reachable,
        })),
      },
    };
  },

  commands: [
    {
      name: 'pair',
      label: 'קישור לגשר (לחצו קודם על הכפתור)',
      async run(ctx: DriverContext) {
        const res = await fetch(`http://${ctx.ip}/api`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ devicetype: 'homecontrol#local node' }),
          signal: AbortSignal.timeout(6000),
        });
        const body = (await res.json()) as [{ success?: { username: string }; error?: { description: string } }];
        const entry = body[0];

        if (entry?.error) {
          // 101 is "link button not pressed", by far the most common case.
          throw new DriverError(`הקישור נדחה: ${entry.error.description}. ${HINT}`, 428);
        }
        if (!entry?.success?.username) throw new DriverError('Bridge gave no username back', 502);

        log.info(`paired with Hue bridge at ${ctx.ip}`);
        // Returned to the caller, which persists it into driverConfig.
        return { config: { username: entry.success.username }, message: 'Paired' };
      },
    },
    {
      name: 'allOn',
      label: 'הדלק הכל',
      async run(ctx) {
        const username = requireConfig(ctx, 'username', HINT);
        return huePut(ctx.ip, `/api/${username}/groups/0/action`, { on: true });
      },
    },
    {
      name: 'allOff',
      label: 'כבה הכל',
      async run(ctx) {
        const username = requireConfig(ctx, 'username', HINT);
        return huePut(ctx.ip, `/api/${username}/groups/0/action`, { on: false });
      },
    },
    {
      name: 'setLight',
      label: 'הגדר נורה',
      params: [
        { key: 'light', label: 'מזהה נורה', type: 'string' },
        { key: 'on', label: 'דולק', type: 'boolean' },
        { key: 'brightness', label: 'בהירות 1-254', type: 'number' },
      ],
      async run(ctx, args) {
        const username = requireConfig(ctx, 'username', HINT);
        const light = String(args['light'] ?? '').trim();
        if (!light) throw new DriverError('light id is required');

        const body: Record<string, unknown> = {};
        if (args['on'] !== undefined) body['on'] = Boolean(args['on']);
        if (args['brightness'] !== undefined) {
          const bri = Number(args['brightness']);
          if (!Number.isFinite(bri) || bri < 1 || bri > 254) {
            throw new DriverError('brightness must be between 1 and 254');
          }
          body['bri'] = Math.round(bri);
        }
        if (Object.keys(body).length === 0) throw new DriverError('nothing to change');

        return huePut(ctx.ip, `/api/${username}/lights/${encodeURIComponent(light)}/state`, body);
      },
    },
  ],
};
