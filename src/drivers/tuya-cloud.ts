import crypto from 'node:crypto';
import { logger } from '../logger.js';

const log = logger('tuya-cloud');

/**
 * Tuya Cloud client — used once, to fetch the local keys.
 *
 * Tuya encrypts local control with a per-device key that only the vendor cloud
 * knows. There is no way to derive it from the network, so this is the one part
 * of Tuya support that needs an internet round trip. After the keys are stored,
 * every command goes straight to the device on TCP 6668 and the cloud is never
 * touched again.
 *
 * Requires a free developer account at iot.tuya.com with the Smart Life app
 * account linked to the project. Read-only scope is enough.
 */

/** Regional endpoints. The wrong one returns an empty device list, not an error. */
export const TUYA_REGIONS = {
  eu: { url: 'https://openapi.tuyaeu.com', label: 'Central Europe' },
  us: { url: 'https://openapi.tuyaus.com', label: 'Western America' },
  cn: { url: 'https://openapi.tuyacn.com', label: 'China' },
  in: { url: 'https://openapi.tuyain.com', label: 'India' },
  'us-east': { url: 'https://openapi-ueaz.tuyaus.com', label: 'Eastern America' },
  'eu-west': { url: 'https://openapi-weaz.tuyaeu.com', label: 'Western Europe' },
} as const;

export type TuyaRegion = keyof typeof TUYA_REGIONS;

export interface TuyaCloudDevice {
  id: string;
  name: string;
  /** The AES key for local control. This is the whole point of the exercise. */
  localKey: string;
  /** IP as the cloud last saw it — used to match against our own scan. */
  ip: string | null;
  mac: string | null;
  productName: string | null;
  category: string | null;
  online: boolean;
  /** Local protocol version: "3.1", "3.3", "3.4" or "3.5". Changes the framing. */
  version: string | null;
}

export class TuyaCloudError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'TuyaCloudError';
  }
}

const sha256 = (input: string) => crypto.createHash('sha256').update(input).digest('hex');

/**
 * Build Tuya's request signature.
 *
 * str = clientId + accessToken + timestamp + nonce + stringToSign, HMAC-SHA256
 * with the secret, uppercased. stringToSign folds in the method, a hash of the
 * body, an (unused) header list and the full path including its query string.
 */
function sign(
  clientId: string,
  secret: string,
  accessToken: string,
  timestamp: string,
  nonce: string,
  method: string,
  path: string,
  body: string,
): string {
  const stringToSign = [method.toUpperCase(), sha256(body), '', path].join('\n');
  const payload = clientId + accessToken + timestamp + nonce + stringToSign;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex').toUpperCase();
}

export class TuyaCloud {
  #token: string | null = null;

  constructor(
    private readonly clientId: string,
    private readonly secret: string,
    private readonly region: TuyaRegion = 'eu',
  ) {}

  get baseUrl(): string {
    return TUYA_REGIONS[this.region].url;
  }

  async #request<T>(path: string, withToken: boolean): Promise<T> {
    const timestamp = Date.now().toString();
    const nonce = '';
    const accessToken = withToken ? (this.#token ?? '') : '';

    const signature = sign(
      this.clientId, this.secret, accessToken, timestamp, nonce, 'GET', path, '',
    );

    const headers: Record<string, string> = {
      client_id: this.clientId,
      sign: signature,
      t: timestamp,
      sign_method: 'HMAC-SHA256',
      nonce,
    };
    if (withToken) headers['access_token'] = accessToken;

    const res = await fetch(`${this.baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    const body = (await res.json()) as { success?: boolean; code?: number; msg?: string; result?: T };

    if (!body.success) {
      // 1106 is "permission deny", almost always the wrong data centre or an
      // unlinked app account rather than a genuinely bad key.
      const hint =
        body.code === 1106
          ? ' — בדרך כלל זה אזור (Data Center) שגוי, או שחשבון האפליקציה לא מקושר לפרויקט'
          : '';
      throw new TuyaCloudError(`Tuya: ${body.msg ?? 'request failed'}${hint}`, body.code);
    }

    return body.result as T;
  }

  /** Exchange the API credentials for an access token. */
  async connect(): Promise<void> {
    const result = await this.#request<{ access_token: string; expire_time: number }>(
      '/v1.0/token?grant_type=1',
      false,
    );
    this.#token = result.access_token;
    log.info(`authenticated against ${TUYA_REGIONS[this.region].label}`);
  }

  /** Every device on the linked app account, with its local key. */
  async devices(): Promise<TuyaCloudDevice[]> {
    if (!this.#token) await this.connect();

    const result = await this.#request<{
      devices?: Record<string, unknown>[];
    } | Record<string, unknown>[]>('/v1.0/iot-01/associated-users/devices?size=100', true);

    // The endpoint has returned both shapes across API versions.
    const raw = Array.isArray(result) ? result : (result.devices ?? []);

    return raw.map((d) => ({
      id: String(d['id'] ?? ''),
      name: String(d['name'] ?? ''),
      localKey: String(d['local_key'] ?? ''),
      ip: typeof d['ip'] === 'string' && d['ip'] ? d['ip'] : null,
      mac: typeof d['mac'] === 'string' && d['mac'] ? d['mac'] : null,
      productName: typeof d['product_name'] === 'string' ? d['product_name'] : null,
      category: typeof d['category'] === 'string' ? d['category'] : null,
      online: d['online'] === true,
      version: typeof d['version'] === 'string' ? d['version'] : null,
    }));
  }
}

export interface RegionProbe {
  region: TuyaRegion;
  /** The credentials were accepted here. */
  authenticated: boolean;
  /** Devices found. Zero with authenticated=true is the telling combination. */
  deviceCount: number;
  error: string | null;
}

export interface TuyaLookup {
  devices: TuyaCloudDevice[];
  region: TuyaRegion | null;
  probes: RegionProbe[];
  /** Plain-language reading of what went wrong, when nothing was found. */
  diagnosis: string | null;
}

/**
 * Ask every region and report precisely what each one said.
 *
 * Tuya's failure modes are easy to confuse, so it is worth separating them:
 * a region that authenticates but returns nothing means the project is fine and
 * the app account is not linked, whereas "data center is suspended" just means
 * that region is not the one the project was created in. Only one region is
 * ever enabled, so several of those errors are expected and harmless.
 */
export async function findDevicesAnyRegion(clientId: string, secret: string): Promise<TuyaLookup> {
  const probes: RegionProbe[] = [];

  for (const region of Object.keys(TUYA_REGIONS) as TuyaRegion[]) {
    try {
      const cloud = new TuyaCloud(clientId, secret, region);
      const devices = await cloud.devices();
      probes.push({ region, authenticated: true, deviceCount: devices.length, error: null });
      if (devices.length > 0) return { devices, region, probes, diagnosis: null };
    } catch (err) {
      const message = (err as Error).message;
      // "Suspended" means the project does not use this data centre — expected
      // for all but one region, so it is not evidence of a problem.
      probes.push({
        region,
        authenticated: !/permission|suspended|cross-region/i.test(message),
        deviceCount: 0,
        error: message,
      });
    }
  }

  const live = probes.filter((p) => p.authenticated && !p.error);

  let diagnosis: string;
  if (live.length > 0) {
    diagnosis =
      `האישורים תקינים והאזור ${TUYA_REGIONS[live[0]!.region].label} פעיל, אבל אין בו מכשירים. ` +
      'המשמעות היא שחשבון האפליקציה עוד לא מקושר לפרויקט: ' +
      'Devices ← Link Tuya App Account ← Add App Account, ואז לסרוק את קוד ה-QR ' +
      'מאפליקציית Smart Life (לשונית Me ← אייקון סריקה מימין למעלה).';
  } else if (probes.some((p) => /cross-region/i.test(p.error ?? ''))) {
    diagnosis = 'הבקשה נחסמה גיאוגרפית. ודאו שהפרויקט נוצר באזור שמתאים למיקומכם.';
  } else {
    diagnosis =
      'אף אזור לא קיבל את האישורים. בדקו שה-Access ID וה-Secret הועתקו במלואם, ' +
      'ושתחת Service API מנויים על IoT Core ועל Authorization.';
  }

  log.warn(diagnosis);
  return { devices: [], region: null, probes, diagnosis };
}
