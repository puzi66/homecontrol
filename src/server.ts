import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { CONFIG, PATHS } from './config.js';
import { engine } from './automations/engine.js';
import { automations } from './automations/store.js';
import type { Rule, Scene } from './automations/types.js';
import { dhcpWatcher } from './discovery/dhcp.js';
import { activeInterfaces } from './discovery/net.js';
import { DriverError, deviceState, driverCatalogue, probeDevice, runCommand } from './drivers/index.js';
import { callService, entitiesInDomains, haAvailable } from './ha/client.js';
import type { DeviceKind, ScanProgress } from './discovery/types.js';
import { scanWifiNetworks } from './discovery/wifi.js';
import { logger } from './logger.js';
import { detectCapabilities, reportCapabilities, type Capabilities } from './platform.js';
import { seen } from './registry/seen.js';
import { registry } from './registry/store.js';
import type { AdoptRequest } from './registry/types.js';
import { scanManager } from './scan-manager.js';

let capabilities: Capabilities | null = null;

const log = logger('server');

const VALID_KINDS: DeviceKind[] = [
  'router', 'vacuum', 'light', 'speaker', 'tv', 'media', 'camera', 'sensor',
  'plug', 'thermostat', 'printer', 'computer', 'phone', 'nas', 'hub', 'iot', 'unknown',
];

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: PATHS.web, prefix: '/' });

  // Several POST endpoints (/probe, /scan) take no body at all. Without this,
  // a client that omits the content-type — curl -X POST, Invoke-RestMethod —
  // gets a 415 instead of doing the obvious thing. The built-in application/json
  // parser still handles real JSON bodies; this is only the fallback.
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(null, undefined);
    }
  });

  // --- Health and environment -------------------------------------------

  app.get('/api/health', async () => ({
    ok: true,
    version: 1,
    scanning: scanManager.isRunning,
    lastScanAt: registry.lastScanAt(),
    deviceCount: registry.list().length,
  }));

  app.get('/api/interfaces', async () => ({ interfaces: await activeInterfaces() }));

  /** What this host can actually do, so the dashboard can explain any gaps. */
  app.get('/api/capabilities', async () => ({
    capabilities: capabilities ?? (capabilities = await detectCapabilities()),
  }));

  // --- Discovery ---------------------------------------------------------

  /**
   * Most recent scan result without starting a new one.
   *
   * When this process has not scanned yet, the devices come from the persisted
   * ledger instead of an empty list — the network does not stop existing
   * because the server restarted.
   */
  app.get('/api/scan', async () => {
    const { devices, fromLedger } = scanManager.discoveredDevices();
    return {
      running: scanManager.isRunning,
      fromLedger,
      result: scanManager.lastResult ?? {
        startedAt: seen.lastScanAt(),
        finishedAt: seen.lastScanAt(),
        durationMs: 0,
        interfaces: [],
        subnetsScanned: [],
        devices,
        wifiNetworks: [],
        hostDiscovery: 'arp' as const,
      },
    };
  });

  /** The full ledger: everything ever seen, present or not. */
  app.get('/api/seen', async () => ({
    devices: seen.list(),
    lastScanAt: seen.lastScanAt(),
  }));

  app.delete<{ Params: { id: string } }>('/api/seen/:id', async (request, reply) => {
    const ok = await seen.forget(decodeURIComponent(request.params.id));
    if (!ok) return reply.code(404).send({ error: 'device not found in the ledger' });
    return reply.code(204).send();
  });

  app.delete('/api/seen', async (_request, reply) => {
    await seen.clear();
    return reply.code(204).send();
  });

  /**
   * Kick off a scan. Returns immediately with 202; progress arrives over the
   * WebSocket at /api/scan/stream and the final result lands on GET /api/scan.
   */
  app.post<{ Body?: { subnets?: string[]; skipPortScan?: boolean; skipWifi?: boolean; deep?: boolean } }>(
    '/api/scan',
    async (request, reply) => {
      const body = request.body ?? {};
      const alreadyRunning = scanManager.isRunning;

      scanManager.start({
        subnets: Array.isArray(body.subnets) && body.subnets.length > 0 ? body.subnets : undefined,
        skipPortScan: body.skipPortScan === true,
        skipWifi: body.skipWifi === true,
        deep: body.deep === true,
      }).catch(() => {
        // Errors are surfaced through the progress stream; swallow here so an
        // unhandled rejection cannot take the process down.
      });

      return reply.code(202).send({ started: !alreadyRunning, joined: alreadyRunning });
    },
  );

  /** Live scan progress. Replays events already emitted so late joiners catch up. */
  app.get('/api/scan/stream', { websocket: true }, (socket) => {
    const send = (event: ScanProgress) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    for (const event of scanManager.progressLog) send(event);
    if (!scanManager.isRunning && scanManager.lastResult) {
      send({ phase: 'done', result: scanManager.lastResult });
    }

    scanManager.on('progress', send);
    socket.on('close', () => scanManager.off('progress', send));
    socket.on('error', () => scanManager.off('progress', send));
  });

  app.get('/api/wifi', async () => ({ networks: await scanWifiNetworks() }));

  // --- Registry ----------------------------------------------------------

  app.get('/api/devices', async () => ({
    devices: registry.list(),
    rooms: registry.rooms(),
  }));

  app.post<{ Body: AdoptRequest }>('/api/devices', async (request, reply) => {
    const body = request.body;

    if (!body?.ip || typeof body.ip !== 'string') {
      return reply.code(400).send({ error: 'ip is required' });
    }
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(body.ip)) {
      return reply.code(400).send({ error: 'ip must be an IPv4 address' });
    }
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return reply.code(400).send({ error: 'name is required' });
    }
    if (body.kind && !VALID_KINDS.includes(body.kind)) {
      return reply.code(400).send({ error: `kind must be one of: ${VALID_KINDS.join(', ')}` });
    }

    // Prefer the full discovery record when this device came from a scan, so we
    // keep its evidence, ports and suggested driver.
    const discovered = scanManager.lastResult?.devices.find(
      (d) => (body.id && d.id === body.id) || d.ip === body.ip,
    );

    const device = await registry.adopt({ ...body, name: body.name.trim() }, discovered);
    return reply.code(201).send({ device });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/devices/:id',
    async (request, reply) => {
      const patch = request.body ?? {};

      if ('kind' in patch && !VALID_KINDS.includes(patch['kind'] as DeviceKind)) {
        return reply.code(400).send({ error: `kind must be one of: ${VALID_KINDS.join(', ')}` });
      }
      if ('name' in patch && (typeof patch['name'] !== 'string' || !patch['name'].trim())) {
        return reply.code(400).send({ error: 'name cannot be empty' });
      }

      const updated = await registry.update(decodeURIComponent(request.params.id), patch);
      if (!updated) return reply.code(404).send({ error: 'device not found' });
      return { device: updated };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (request, reply) => {
    const ok = await registry.remove(decodeURIComponent(request.params.id));
    if (!ok) return reply.code(404).send({ error: 'device not found' });
    return reply.code(204).send();
  });

  app.post<{ Body: { name: string } }>('/api/rooms', async (request, reply) => {
    const name = request.body?.name;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ error: 'name is required' });
    }
    return { rooms: await registry.addRoom(name) };
  });

  // --- Drivers -----------------------------------------------------------

  app.get('/api/drivers', async () => ({ drivers: driverCatalogue() }));

  /** Live state read straight from the device, not from the registry cache. */
  app.get<{ Params: { id: string } }>('/api/devices/:id/state', async (request, reply) => {
    try {
      return { state: await deviceState(decodeURIComponent(request.params.id)) };
    } catch (err) {
      const e = err as DriverError;
      return reply.code(e.status ?? 502).send({ error: e.message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/devices/:id/probe', async (request, reply) => {
    try {
      return await probeDevice(decodeURIComponent(request.params.id));
    } catch (err) {
      const e = err as DriverError;
      return reply.code(e.status ?? 502).send({ error: e.message });
    }
  });

  app.post<{ Params: { id: string }; Body: { command: string; args?: Record<string, unknown> } }>(
    '/api/devices/:id/command',
    async (request, reply) => {
      const command = request.body?.command;
      if (!command || typeof command !== 'string') {
        return reply.code(400).send({ error: 'command is required' });
      }
      try {
        const result = await runCommand(
          decodeURIComponent(request.params.id),
          command,
          request.body.args ?? {},
        );
        return { ok: true, result };
      } catch (err) {
        const e = err as DriverError;
        return reply.code(e.status ?? 502).send({ error: e.message });
      }
    },
  );

  // --- Live device state -------------------------------------------------

  /** Cached state for every driver-backed device, refreshed by the engine. */
  app.get('/api/states', async () => ({ states: engine.states(), sun: engine.sunToday() }));

  /**
   * Push channel for the dashboard: device state on every poll, plus a nudge
   * whenever rules, scenes or the log change.
   */
  app.get('/api/events', { websocket: true }, (socket) => {
    const send = (type: string, payload: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type, payload }));
    };

    send('states', { states: engine.states(), sun: engine.sunToday() });

    const onStates = (states: unknown) => send('states', { states, sun: engine.sunToday() });
    const onRan = () => send('automations', { rules: automations.rules(), log: automations.logEntries(40) });
    const offStore = automations.onChange(onRan);

    engine.on('states', onStates);
    engine.on('ran', onRan);

    const cleanup = () => {
      engine.off('states', onStates);
      engine.off('ran', onRan);
      offStore();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // --- Automations and scenes -------------------------------------------

  app.get('/api/automations', async () => ({
    rules: automations.rules(),
    scenes: automations.scenes(),
    log: automations.logEntries(40),
    sun: engine.sunToday(),
  }));

  app.post<{ Body: Partial<Rule> & { name?: string } }>('/api/automations/rules', async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name?.trim()) return reply.code(400).send({ error: 'צריך שם לכלל' });
    if (body.triggers && !Array.isArray(body.triggers)) {
      return reply.code(400).send({ error: 'triggers must be an array' });
    }
    if (!body.id && (!body.actions || body.actions.length === 0)) {
      return reply.code(400).send({ error: 'צריך לפחות פעולה אחת' });
    }
    const rule = await automations.saveRule({ ...body, name: body.name.trim() });
    return reply.code(body.id ? 200 : 201).send({ rule });
  });

  app.delete<{ Params: { id: string } }>('/api/automations/rules/:id', async (request, reply) => {
    const ok = await automations.deleteRule(decodeURIComponent(request.params.id));
    if (!ok) return reply.code(404).send({ error: 'הכלל לא נמצא' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/automations/rules/:id/run', async (request, reply) => {
    const rule = automations.rule(decodeURIComponent(request.params.id));
    if (!rule) return reply.code(404).send({ error: 'הכלל לא נמצא' });
    try {
      // Manual runs bypass conditions — the user asked for it explicitly.
      const detail = await engine.executeActions(rule.actions);
      await automations.markRuleRun(rule.id, 'ok');
      await automations.append({
        subject: rule.name,
        kind: 'rule',
        outcome: 'ok',
        detail,
        because: 'הפעלה ידנית',
      });
      return { ok: true, detail };
    } catch (err) {
      const message = (err as Error).message;
      await automations.markRuleRun(rule.id, 'failed');
      await automations.append({
        subject: rule.name,
        kind: 'rule',
        outcome: 'failed',
        detail: message,
        because: 'הפעלה ידנית',
      });
      return reply.code(502).send({ error: message });
    }
  });

  app.post<{ Body: Partial<Scene> & { name?: string } }>('/api/automations/scenes', async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name?.trim()) return reply.code(400).send({ error: 'צריך שם לסצנה' });
    if (!body.id && (!body.actions || body.actions.length === 0)) {
      return reply.code(400).send({ error: 'צריך לפחות פעולה אחת' });
    }
    const scene = await automations.saveScene({ ...body, name: body.name.trim() });
    return reply.code(body.id ? 200 : 201).send({ scene });
  });

  app.delete<{ Params: { id: string } }>('/api/automations/scenes/:id', async (request, reply) => {
    const ok = await automations.deleteScene(decodeURIComponent(request.params.id));
    if (!ok) return reply.code(404).send({ error: 'הסצנה לא נמצאה' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/automations/scenes/:id/run', async (request, reply) => {
    try {
      return { ok: true, detail: await engine.runScene(decodeURIComponent(request.params.id)) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get('/api/log', async () => ({ log: automations.logEntries(120) }));

  app.delete('/api/log', async (_request, reply) => {
    await automations.clearLog();
    return reply.code(204).send();
  });

  // --- Home Assistant bridge --------------------------------------------

  app.get('/api/ha/status', async () => haAvailable());

  app.get<{ Querystring: { domains?: string } }>('/api/ha/entities', async (request, reply) => {
    const domains = (request.query.domains ?? 'light,switch,vacuum,media_player,sensor')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    try {
      return { entities: await entitiesInDomains(domains) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { domain: string; service: string; data?: Record<string, unknown> } }>(
    '/api/ha/service',
    async (request, reply) => {
      const { domain, service, data } = request.body ?? {};
      if (!domain || !service) return reply.code(400).send({ error: 'domain and service are required' });
      try {
        return { ok: true, result: await callService(domain, service, data ?? {}) };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    log.error(`unhandled: ${error.message}`);
    reply.code(error.statusCode ?? 500).send({ error: error.message });
  });

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  capabilities = await detectCapabilities();
  reportCapabilities(capabilities);

  await registry.load();
  await seen.load();
  await automations.load();

  // Passive, best-effort: devices name themselves when they boot or renew a
  // lease, and that beats anything a scan can infer. Failing to bind port 67 is
  // not fatal — it just means names come from scans alone.
  dhcpWatcher.on('sighting', (sighting) => {
    void seen.noteDhcp(sighting).catch((err) => {
      log.warn(`could not record a DHCP sighting: ${(err as Error).message}`);
    });
  });
  dhcpWatcher.start();

  const app = await buildServer();
  await app.listen({ port: CONFIG.port, host: CONFIG.host });

  // Started after listen so a slow first device poll cannot delay the server.
  engine.start();

  log.info(`dashboard on http://localhost:${CONFIG.port}`);
  return app;
}
