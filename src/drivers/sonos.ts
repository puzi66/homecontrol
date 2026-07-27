import { DriverError, type Driver, type DriverContext } from './types.js';

/**
 * Sonos speaker over its local UPnP/SOAP control API on port 1400.
 *
 * No account, no cloud: the speaker exposes the standard AVTransport and
 * RenderingControl services and answers plain HTTP SOAP on the LAN.
 */

const PORT = 1400;

const SERVICES = {
  transport: {
    path: '/MediaRenderer/AVTransport/Control',
    urn: 'urn:schemas-upnp-org:service:AVTransport:1',
  },
  rendering: {
    path: '/MediaRenderer/RenderingControl/Control',
    urn: 'urn:schemas-upnp-org:service:RenderingControl:1',
  },
} as const;

type ServiceName = keyof typeof SERVICES;

async function soap(
  ip: string,
  service: ServiceName,
  action: string,
  args: Record<string, string | number> = {},
): Promise<string> {
  const { path, urn } = SERVICES[service];
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`)
    .join('');

  const envelope =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${urn}">${body}</u:${action}></s:Body></s:Envelope>`;

  const res = await fetch(`http://${ip}:${PORT}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      soapaction: `"${urn}#${action}"`,
    },
    body: envelope,
    signal: AbortSignal.timeout(5000),
  });

  const text = await res.text();
  if (!res.ok) {
    const fault = text.match(/<errorDescription>([^<]*)<\/errorDescription>/i)?.[1];
    throw new DriverError(`Sonos ${action} failed: ${fault ?? res.status}`, 502);
  }
  return text;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return m?.[1] ?? null;
}

/** Track title/artist live inside an XML-escaped DIDL blob in the response. */
function nowPlaying(xml: string): { title: string | null; artist: string | null } {
  const meta = tag(xml, 'TrackMetaData') ?? '';
  const decoded = meta
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  return {
    title: decoded.match(/<dc:title>([^<]*)<\/dc:title>/i)?.[1] ?? null,
    artist: decoded.match(/<dc:creator>([^<]*)<\/dc:creator>/i)?.[1] ?? null,
  };
}

const INSTANCE = { InstanceID: 0 };

export const sonosDriver: Driver = {
  id: 'sonos',
  label: 'רמקול Sonos',
  kinds: ['speaker'],
  requires: [],

  async probe(ctx) {
    try {
      await soap(ctx.ip, 'transport', 'GetTransportInfo', INSTANCE);
      return { ok: true, message: 'הרמקול נגיש בפורט 1400' };
    } catch (err) {
      return { ok: false, message: `אין גישה לרמקול: ${(err as Error).message}` };
    }
  },

  async state(ctx) {
    const [transport, position, volume, mute] = await Promise.all([
      soap(ctx.ip, 'transport', 'GetTransportInfo', INSTANCE),
      soap(ctx.ip, 'transport', 'GetPositionInfo', INSTANCE),
      soap(ctx.ip, 'rendering', 'GetVolume', { ...INSTANCE, Channel: 'Master' }),
      soap(ctx.ip, 'rendering', 'GetMute', { ...INSTANCE, Channel: 'Master' }),
    ]);

    const status = tag(transport, 'CurrentTransportState') ?? 'UNKNOWN';
    const track = nowPlaying(position);
    const level = Number(tag(volume, 'CurrentVolume') ?? '0');
    const muted = tag(mute, 'CurrentMute') === '1';

    const playing = status === 'PLAYING';
    const STATES: Record<string, string> = {
      PLAYING: 'מנגן',
      PAUSED_PLAYBACK: 'מושהה',
      STOPPED: 'עצור',
      TRANSITIONING: 'עובר רצועה',
      NO_MEDIA_PRESENT: 'אין מה לנגן',
    };
    const label = playing && track.title
      ? `${track.title}${track.artist ? ` — ${track.artist}` : ''}`
      : (STATES[status] ?? status);

    return {
      online: true,
      summary: `${label} · עוצמה ${level}${muted ? ' (מושתק)' : ''}`,
      values: {
        transportState: status,
        playing,
        volume: level,
        muted,
        title: track.title,
        artist: track.artist,
        position: tag(position, 'RelTime'),
        duration: tag(position, 'TrackDuration'),
      },
    };
  },

  commands: [
    {
      name: 'play',
      label: 'נגן',
      run: (ctx: DriverContext) => soap(ctx.ip, 'transport', 'Play', { ...INSTANCE, Speed: 1 }),
    },
    {
      name: 'pause',
      label: 'השהה',
      run: (ctx) => soap(ctx.ip, 'transport', 'Pause', INSTANCE),
    },
    {
      name: 'stop',
      label: 'עצור',
      run: (ctx) => soap(ctx.ip, 'transport', 'Stop', INSTANCE),
    },
    {
      name: 'next',
      label: 'הרצועה הבאה',
      run: (ctx) => soap(ctx.ip, 'transport', 'Next', INSTANCE),
    },
    {
      name: 'previous',
      label: 'הרצועה הקודמת',
      run: (ctx) => soap(ctx.ip, 'transport', 'Previous', INSTANCE),
    },
    {
      name: 'setVolume',
      label: 'הגדר עוצמה',
      params: [{ key: 'volume', label: 'עוצמה 0-100', type: 'number' }],
      async run(ctx, args) {
        const volume = Number(args['volume']);
        if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
          throw new DriverError('volume must be between 0 and 100');
        }
        return soap(ctx.ip, 'rendering', 'SetVolume', {
          ...INSTANCE,
          Channel: 'Master',
          DesiredVolume: Math.round(volume),
        });
      },
    },
    {
      name: 'mute',
      label: 'השתק / בטל השתקה',
      params: [{ key: 'muted', label: 'מושתק', type: 'boolean' }],
      run: (ctx, args) =>
        soap(ctx.ip, 'rendering', 'SetMute', {
          ...INSTANCE,
          Channel: 'Master',
          DesiredMute: args['muted'] === false ? 0 : 1,
        }),
    },
  ],
};
