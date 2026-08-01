import { CastError, withCast, type CastClient } from './castv2.js';
import { DriverError, type Driver, type DriverContext } from './types.js';

/**
 * Chromecasts, Nest displays, Google speakers and Android TV boxes.
 *
 * Entirely local — TLS to port 8009 on the device — and needs no pairing, key
 * or account, which makes it the cheapest driver here to set up: assign it and
 * it works.
 */

/** Apps that mean "nothing is playing", so they should not read as activity. */
const IDLE_APPS = new Set(['Backdrop', 'Default Media Receiver', 'Ambient']);

const PLAYER_STATES: Record<string, string> = {
  PLAYING: 'מנגן',
  PAUSED: 'מושהה',
  BUFFERING: 'טוען',
  IDLE: 'ממתין',
};

async function run<T>(ctx: DriverContext, fn: (client: CastClient) => Promise<T>): Promise<T> {
  try {
    return await withCast(ctx.ip, fn);
  } catch (err) {
    if (err instanceof CastError) throw new DriverError(err.message, 502);
    throw err;
  }
}

/** Resolve the running media session, or explain why there is not one. */
async function mediaSession(client: CastClient): Promise<{ transportId: string; sessionId: number }> {
  const receiver = await client.receiverStatus();
  if (!receiver.transportId) {
    throw new DriverError('לא רץ שום דבר על המכשיר — אין מה לשלוט בו', 409);
  }
  const media = await client.mediaStatus(receiver.transportId);
  if (!media?.mediaSessionId) {
    throw new DriverError(`"${receiver.displayName ?? 'האפליקציה'}" פועלת אבל לא מנגנת מדיה`, 409);
  }
  return { transportId: receiver.transportId, sessionId: media.mediaSessionId };
}

export const castDriver: Driver = {
  id: 'cast',
  label: 'Google Cast — Chromecast / Nest / Android TV',
  kinds: ['tv', 'media', 'speaker'],
  requires: [],

  async probe(ctx) {
    try {
      const status = await run(ctx, (c) => c.receiverStatus());
      const volume = status.volumeLevel === null ? '?' : `${Math.round(status.volumeLevel * 100)}%`;
      return {
        ok: true,
        message: `מחובר — עוצמה ${volume}, ${status.displayName ? `מריץ ${status.displayName}` : 'ללא אפליקציה'}`,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  },

  async state(ctx) {
    const { receiver, media } = await run(ctx, async (client) => {
      const receiver = await client.receiverStatus();
      const media = receiver.transportId ? await client.mediaStatus(receiver.transportId) : null;
      return { receiver, media };
    });

    const app = receiver.displayName;
    const idle = !app || IDLE_APPS.has(app);
    const playing = media?.playerState === 'PLAYING';

    const bits: string[] = [];
    if (media?.title) {
      bits.push(media.title);
      if (media.subtitle) bits.push(media.subtitle);
    } else if (media?.playerState) {
      bits.push(PLAYER_STATES[media.playerState] ?? media.playerState);
    } else {
      bits.push(idle ? 'ממתין' : app);
    }
    if (receiver.volumeLevel !== null) {
      bits.push(`עוצמה ${Math.round(receiver.volumeLevel * 100)}%${receiver.muted ? ' (מושתק)' : ''}`);
    }

    return {
      online: true,
      summary: bits.join(' · '),
      values: {
        playing,
        // Backdrop is a screensaver; treating it as activity would light up
        // every idle display in the house.
        active: playing || (!idle && Boolean(app)),
        app,
        appId: receiver.appId,
        statusText: receiver.statusText,
        volume: receiver.volumeLevel === null ? null : Math.round(receiver.volumeLevel * 100),
        muted: receiver.muted,
        title: media?.title ?? null,
        subtitle: media?.subtitle ?? null,
        playerState: media?.playerState ?? null,
        position: media?.currentTime ?? null,
        duration: media?.duration ?? null,
      },
    };
  },

  commands: [
    {
      name: 'play',
      label: 'נגן',
      run: (ctx) =>
        run(ctx, async (c) => {
          const s = await mediaSession(c);
          await c.mediaCommand(s.transportId, s.sessionId, 'PLAY');
          return { ok: true };
        }),
    },
    {
      name: 'pause',
      label: 'השהה',
      run: (ctx) =>
        run(ctx, async (c) => {
          const s = await mediaSession(c);
          await c.mediaCommand(s.transportId, s.sessionId, 'PAUSE');
          return { ok: true };
        }),
    },
    {
      name: 'stop',
      label: 'עצור ניגון',
      run: (ctx) =>
        run(ctx, async (c) => {
          const s = await mediaSession(c);
          await c.mediaCommand(s.transportId, s.sessionId, 'STOP');
          return { ok: true };
        }),
    },
    {
      name: 'setVolume',
      label: 'הגדר עוצמה',
      params: [{ key: 'volume', label: 'עוצמה 0-100', type: 'number' }],
      run: (ctx, args) =>
        run(ctx, async (c) => {
          const volume = Number(args['volume']);
          if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
            throw new DriverError('העוצמה חייבת להיות בין 0 ל-100');
          }
          await c.setVolume(volume / 100);
          return { ok: true, volume };
        }),
    },
    {
      name: 'mute',
      label: 'השתק / בטל השתקה',
      params: [{ key: 'muted', label: 'מושתק', type: 'boolean' }],
      run: (ctx, args) =>
        run(ctx, async (c) => {
          await c.setMuted(args['muted'] !== false);
          return { ok: true };
        }),
    },
    {
      name: 'stopApp',
      label: 'סגור את האפליקציה הפועלת',
      run: (ctx) =>
        run(ctx, async (c) => {
          const receiver = await c.receiverStatus();
          const sessionId = receiver.transportId;
          if (!sessionId) throw new DriverError('לא רצה שום אפליקציה', 409);
          await c.stopApp(sessionId);
          return { ok: true, closed: receiver.displayName };
        }),
    },
  ],
};
