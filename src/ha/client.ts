import { CONFIG } from '../config.js';
import { logger } from '../logger.js';

const log = logger('ha');

/**
 * Thin client for the Home Assistant REST API.
 *
 * In the hybrid setup HA owns the device integrations that already exist and
 * work well (Hue, Sonos, Cast, Xiaomi), while this project owns discovery, the
 * registry and any logic we want to write ourselves. This client is the seam
 * between the two.
 *
 * Needs a long-lived access token: HA profile page -> Security -> Long-lived
 * access tokens. Put it in HA_TOKEN.
 */

export interface HaEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
}

export class HaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'HaError';
  }
}

function assertConfigured(): void {
  if (!CONFIG.ha.token) {
    throw new HaError('HA_TOKEN is not set — create a long-lived access token in Home Assistant', 412);
  }
}

async function haFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  assertConfigured();

  const res = await fetch(`${CONFIG.ha.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${CONFIG.ha.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new HaError(`Home Assistant returned ${res.status} for ${path}`, res.status);
  }
  return (await res.json()) as T;
}

/** True when HA is reachable and the token works. */
export async function haAvailable(): Promise<{ ok: boolean; message: string }> {
  if (!CONFIG.ha.token) {
    return { ok: false, message: 'HA_TOKEN is not set' };
  }
  try {
    const body = await haFetch<{ message: string }>('/api/');
    return { ok: true, message: body.message ?? 'connected' };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function listEntities(): Promise<HaEntity[]> {
  return haFetch<HaEntity[]>('/api/states');
}

export async function getEntity(entityId: string): Promise<HaEntity> {
  return haFetch<HaEntity>(`/api/states/${encodeURIComponent(entityId)}`);
}

/** Call a service, e.g. callService('light', 'turn_on', { entity_id: 'light.kitchen' }). */
export async function callService(
  domain: string,
  service: string,
  data: Record<string, unknown> = {},
): Promise<HaEntity[]> {
  log.info(`calling ${domain}.${service}`);
  return haFetch<HaEntity[]>(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** Entities whose id starts with one of the given domains, e.g. ['light', 'vacuum']. */
export async function entitiesInDomains(domains: string[]): Promise<HaEntity[]> {
  const all = await listEntities();
  return all.filter((e) => domains.some((d) => e.entity_id.startsWith(`${d}.`)));
}
