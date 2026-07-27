import { EventEmitter } from 'node:events';
import { CONFIG } from '../config.js';
import { deviceState, runCommand } from '../drivers/index.js';
import { logger } from '../logger.js';
import { registry } from '../registry/store.js';
import { automations } from './store.js';
import { minutesOfDay, parseHhmm, sunTimes } from './sun.js';
import type { Action, CompareOp, Condition, Rule, Trigger } from './types.js';
import { describeTrigger } from './types.js';

const log = logger('engine');

/** How often triggers are evaluated. */
const TICK_MS = 15_000;
/** How often device state is refreshed for the tiles and the watchers. */
const POLL_MS = 20_000;

export interface CachedState {
  deviceId: string;
  online: boolean;
  summary: string;
  values: Record<string, unknown>;
  at: string;
  error: string | null;
}

/** Pull a dotted path out of a cached state, e.g. "values.battery". */
function readPath(state: CachedState, path: string): unknown {
  if (path === 'online') return state.online;
  if (path === 'summary') return state.summary;

  const parts = path.replace(/^values\./, '').split('.');
  let current: unknown = state.values;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compare(left: unknown, op: CompareOp, right: unknown): boolean {
  switch (op) {
    case '==':
      // Loose on purpose: a trigger written as "on == true" should match the
      // string "true" coming back from a form as well as the boolean.
      return String(left) === String(right);
    case '!=':
      return String(left) !== String(right);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const a = Number(left);
      const b = Number(right);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (op === '<') return a < b;
      if (op === '<=') return a <= b;
      if (op === '>') return a > b;
      return a >= b;
    }
    case 'changed':
      return true; // handled by the caller, which has the previous value
  }
}

/**
 * Runs the automation rules.
 *
 * Two clocks: a trigger tick and a slower device-state poll. Time-based
 * triggers are deduplicated per minute so a 15-second tick cannot fire the same
 * 07:30 rule four times, and state-based triggers are edge-triggered — they
 * fire on the transition into a matching value, not for as long as it matches.
 */
class AutomationEngine extends EventEmitter {
  #tickTimer: NodeJS.Timeout | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #states = new Map<string, CachedState>();
  /** Previous poll's states, for edge detection. */
  #previous = new Map<string, CachedState>();
  /** Keys of already-fired time triggers, e.g. "rule_x:0:2026-07-26T07:30". */
  #firedKeys = new Set<string>();
  /** Rules currently executing, so a slow run cannot overlap itself. */
  #running = new Set<string>();
  #startedAt = Date.now();

  states(): CachedState[] {
    return [...this.#states.values()];
  }

  state(deviceId: string): CachedState | null {
    return this.#states.get(deviceId) ?? null;
  }

  start(): void {
    if (this.#tickTimer) return;
    this.#startedAt = Date.now();
    log.info('automation engine started');

    // First poll immediately so the dashboard has state to show.
    void this.pollStates();

    this.#pollTimer = setInterval(() => void this.pollStates(), POLL_MS);
    this.#tickTimer = setInterval(() => void this.tick(), TICK_MS);

    // Keep the fired-key set from growing without bound.
    setInterval(() => {
      if (this.#firedKeys.size > 500) this.#firedKeys.clear();
    }, 3_600_000).unref();
  }

  stop(): void {
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#tickTimer = null;
    this.#pollTimer = null;
  }

  /** Refresh cached state for every adopted device that has a driver. */
  async pollStates(): Promise<void> {
    const devices = registry.list().filter((d) => d.driver && d.enabled);

    this.#previous = new Map(this.#states);

    await Promise.all(
      devices.map(async (device) => {
        const at = new Date().toISOString();
        try {
          const state = await deviceState(device.id);
          this.#states.set(device.id, {
            deviceId: device.id,
            online: state.online,
            summary: state.summary,
            values: state.values,
            at,
            error: null,
          });
        } catch (err) {
          // A device that needs configuration, or is simply asleep, is normal.
          this.#states.set(device.id, {
            deviceId: device.id,
            online: false,
            summary: '',
            values: {},
            at,
            error: (err as Error).message,
          });
        }
      }),
    );

    this.emit('states', this.states());
    await this.checkStateTriggers();
  }

  /** Evaluate time, sun and interval triggers. */
  async tick(): Promise<void> {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const nowMinutes = minutesOfDay(now);

    for (const rule of automations.rules()) {
      if (!rule.enabled) continue;

      for (const [index, trigger] of rule.triggers.entries()) {
        let fires = false;
        let key = '';

        if (trigger.type === 'time') {
          const target = parseHhmm(trigger.at);
          if (target === null) continue;
          if (!dayAllowed(trigger.days, now)) continue;
          // Fire on the target minute, or the one after it if a tick was missed.
          if (nowMinutes < target || nowMinutes > target + 1) continue;
          key = `${rule.id}:${index}:${dayKey}:${trigger.at}`;
          fires = true;
        } else if (trigger.type === 'sun') {
          if (!dayAllowed(trigger.days, now)) continue;
          const times = sunTimes(now, CONFIG.location.latitude, CONFIG.location.longitude);
          const base = trigger.event === 'sunrise' ? times.sunrise : times.sunset;
          if (!base) continue;
          const target = minutesOfDay(base) + (trigger.offsetMinutes ?? 0);
          if (nowMinutes < target || nowMinutes > target + 1) continue;
          key = `${rule.id}:${index}:${dayKey}:${trigger.event}`;
          fires = true;
        } else if (trigger.type === 'interval') {
          const every = Math.max(1, trigger.everyMinutes);
          const elapsed = Math.floor((Date.now() - this.#startedAt) / 60_000);
          if (elapsed === 0 || elapsed % every !== 0) continue;
          key = `${rule.id}:${index}:interval:${elapsed}`;
          fires = true;
        }

        if (!fires || this.#firedKeys.has(key)) continue;
        this.#firedKeys.add(key);
        await this.runRule(rule, describeTrigger(trigger));
      }
    }
  }

  /** Evaluate device-state and online triggers against the last two polls. */
  async checkStateTriggers(): Promise<void> {
    for (const rule of automations.rules()) {
      if (!rule.enabled) continue;

      for (const trigger of rule.triggers) {
        if (trigger.type !== 'deviceState' && trigger.type !== 'deviceOnline') continue;

        const current = this.#states.get(trigger.deviceId);
        const before = this.#previous.get(trigger.deviceId);
        if (!current || !before) continue; // need two samples to see an edge

        let fires = false;
        let because = '';

        if (trigger.type === 'deviceOnline') {
          fires = before.online !== current.online && current.online === trigger.online;
          because = trigger.online ? 'המכשיר התחבר' : 'המכשיר התנתק';
        } else {
          const now = readPath(current, trigger.path);
          const prev = readPath(before, trigger.path);

          if (trigger.op === 'changed') {
            fires = JSON.stringify(now) !== JSON.stringify(prev);
            because = `${trigger.path}: ${String(prev)} → ${String(now)}`;
          } else {
            // Edge-triggered: only when it was not matching and now is.
            const matchesNow = compare(now, trigger.op, trigger.value);
            const matchedBefore = compare(prev, trigger.op, trigger.value);
            fires = matchesNow && !matchedBefore;
            because = `${trigger.path} ${trigger.op} ${String(trigger.value)} (${String(now)})`;
          }
        }

        if (fires) await this.runRule(rule, because);
      }
    }
  }

  /** Check every condition on a rule. All must pass. */
  conditionsPass(rule: Rule): { pass: boolean; failed: string | null } {
    const now = new Date();

    for (const condition of rule.conditions) {
      if (condition.type === 'timeWindow') {
        const from = parseHhmm(condition.from);
        const to = parseHhmm(condition.to);
        if (from === null || to === null) continue;
        const mins = minutesOfDay(now);
        // A window like 22:00-06:00 wraps past midnight.
        const inside = from <= to ? mins >= from && mins <= to : mins >= from || mins <= to;
        if (!inside) return { pass: false, failed: `מחוץ לחלון ${condition.from}-${condition.to}` };
      } else if (condition.type === 'dayOfWeek') {
        if (!dayAllowed(condition.days, now)) return { pass: false, failed: 'לא ביום המתאים' };
      } else if (condition.type === 'deviceOnline') {
        const state = this.#states.get(condition.deviceId);
        const online = state?.online ?? false;
        if (online !== condition.online) {
          return { pass: false, failed: condition.online ? 'המכשיר לא מחובר' : 'המכשיר מחובר' };
        }
      } else if (condition.type === 'deviceState') {
        const state = this.#states.get(condition.deviceId);
        if (!state) return { pass: false, failed: 'אין מידע על המכשיר' };
        if (!compare(readPath(state, condition.path), condition.op, condition.value)) {
          return { pass: false, failed: `${condition.path} לא ${condition.op} ${String(condition.value)}` };
        }
      }
    }

    return { pass: true, failed: null };
  }

  /** Run a rule: check conditions, then execute its actions in order. */
  async runRule(rule: Rule, because: string | null): Promise<void> {
    if (this.#running.has(rule.id)) {
      log.debug(`"${rule.name}" already running, skipping`);
      return;
    }

    const { pass, failed } = this.conditionsPass(rule);
    if (!pass) {
      await automations.markRuleRun(rule.id, 'skipped');
      await automations.append({
        subject: rule.name,
        kind: 'rule',
        outcome: 'skipped',
        detail: failed ?? 'תנאי לא התקיים',
        because,
      });
      return;
    }

    this.#running.add(rule.id);
    log.info(`running rule "${rule.name}"${because ? ` (${because})` : ''}`);

    try {
      const detail = await this.executeActions(rule.actions);
      await automations.markRuleRun(rule.id, 'ok');
      await automations.append({ subject: rule.name, kind: 'rule', outcome: 'ok', detail, because });
      this.emit('ran', { rule: rule.id });
    } catch (err) {
      const message = (err as Error).message;
      log.error(`rule "${rule.name}" failed: ${message}`);
      await automations.markRuleRun(rule.id, 'failed');
      await automations.append({ subject: rule.name, kind: 'rule', outcome: 'failed', detail: message, because });
    } finally {
      this.#running.delete(rule.id);
      // Actions usually change device state; refresh so the UI keeps up.
      void this.pollStates();
    }
  }

  async runScene(sceneId: string): Promise<string> {
    const scene = automations.scene(sceneId);
    if (!scene) throw new Error('הסצנה לא נמצאה');

    log.info(`running scene "${scene.name}"`);
    try {
      const detail = await this.executeActions(scene.actions);
      await automations.markSceneRun(sceneId);
      await automations.append({ subject: scene.name, kind: 'scene', outcome: 'ok', detail, because: 'הפעלה ידנית' });
      void this.pollStates();
      return detail;
    } catch (err) {
      const message = (err as Error).message;
      await automations.append({
        subject: scene.name,
        kind: 'scene',
        outcome: 'failed',
        detail: message,
        because: 'הפעלה ידנית',
      });
      throw err;
    }
  }

  /**
   * Execute a list of actions in order, returning a short summary.
   * The first failure aborts the rest — a rule that half-ran is worse than one
   * that stopped and said so.
   */
  async executeActions(actions: Action[], depth = 0): Promise<string> {
    if (depth > 3) throw new Error('סצנות מקננות עמוק מדי');

    const done: string[] = [];

    for (const action of actions) {
      switch (action.type) {
        case 'command': {
          const device = registry.get(action.deviceId);
          const name = device?.name ?? action.deviceId;
          await runCommand(action.deviceId, action.command, action.args ?? {});
          done.push(`${name}: ${action.command}`);
          break;
        }
        case 'scene': {
          const scene = automations.scene(action.sceneId);
          if (!scene) throw new Error(`סצנה ${action.sceneId} לא נמצאה`);
          const inner = await this.executeActions(scene.actions, depth + 1);
          done.push(`סצנה ${scene.name} (${inner})`);
          break;
        }
        case 'delay': {
          const seconds = Math.min(300, Math.max(0, action.seconds));
          await new Promise((r) => setTimeout(r, seconds * 1000));
          done.push(`המתנה ${seconds}s`);
          break;
        }
        case 'note': {
          done.push(action.message);
          break;
        }
      }
    }

    return done.join(' · ') || 'אין פעולות';
  }

  /** Today's sun times, for display in the UI. */
  sunToday(): { sunrise: string | null; sunset: string | null } {
    const times = sunTimes(new Date(), CONFIG.location.latitude, CONFIG.location.longitude);
    const fmt = (d: Date | null) =>
      d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;
    return { sunrise: fmt(times.sunrise), sunset: fmt(times.sunset) };
  }
}

function dayAllowed(days: number[] | undefined, now: Date): boolean {
  if (!days || days.length === 0) return true;
  return days.includes(now.getDay());
}

export const engine = new AutomationEngine();
