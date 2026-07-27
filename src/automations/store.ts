import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { logger } from '../logger.js';
import type { AutomationFile, LogEntry, Rule, Scene } from './types.js';

const log = logger('automations');

const FILE = path.join(PATHS.data, 'automations.json');

/** Keep the log bounded — it is a rolling activity feed, not an audit trail. */
const LOG_LIMIT = 250;

const EMPTY: AutomationFile = { version: 1, rules: [], scenes: [], log: [] };

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

/** JSON-file store for rules, scenes and the activity log. */
export class AutomationStore {
  #state: AutomationFile = structuredClone(EMPTY);
  #loaded = false;
  #writeQueue: Promise<void> = Promise.resolve();
  /** Notified whenever anything changes, so the dashboard can be pushed to. */
  #listeners = new Set<() => void>();

  async load(): Promise<void> {
    if (this.#loaded) return;
    try {
      const raw = await fs.readFile(FILE, 'utf8');
      const parsed = JSON.parse(raw) as AutomationFile;
      if (parsed.version !== 1) throw new Error(`unsupported version ${parsed.version}`);
      this.#state = { ...structuredClone(EMPTY), ...parsed };
      log.info(`loaded ${this.#state.rules.length} rule(s), ${this.#state.scenes.length} scene(s)`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') log.warn(`could not read automations, starting empty: ${e.message}`);
      this.#state = structuredClone(EMPTY);
    }
    this.#loaded = true;
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #persist(): Promise<void> {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (err) {
        log.warn(`change listener threw: ${(err as Error).message}`);
      }
    }
    this.#writeQueue = this.#writeQueue.then(async () => {
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.#state, null, 2), 'utf8');
      await fs.rename(tmp, FILE);
    });
    return this.#writeQueue;
  }

  // --- rules -------------------------------------------------------------

  rules(): Rule[] {
    return structuredClone(this.#state.rules);
  }

  rule(id: string): Rule | null {
    const found = this.#state.rules.find((r) => r.id === id);
    return found ? structuredClone(found) : null;
  }

  async saveRule(input: Partial<Rule> & { name: string }): Promise<Rule> {
    const now = new Date().toISOString();
    const existing = input.id ? this.#state.rules.findIndex((r) => r.id === input.id) : -1;

    if (existing >= 0) {
      const merged: Rule = {
        ...this.#state.rules[existing]!,
        ...input,
        id: this.#state.rules[existing]!.id,
        updatedAt: now,
      };
      this.#state.rules[existing] = merged;
      await this.#persist();
      return structuredClone(merged);
    }

    const rule: Rule = {
      id: input.id ?? newId('rule'),
      name: input.name,
      enabled: input.enabled ?? true,
      triggers: input.triggers ?? [],
      conditions: input.conditions ?? [],
      actions: input.actions ?? [],
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastResult: null,
      runCount: 0,
    };
    this.#state.rules.push(rule);
    await this.#persist();
    log.info(`created rule "${rule.name}"`);
    return structuredClone(rule);
  }

  async deleteRule(id: string): Promise<boolean> {
    const before = this.#state.rules.length;
    this.#state.rules = this.#state.rules.filter((r) => r.id !== id);
    if (this.#state.rules.length === before) return false;
    await this.#persist();
    return true;
  }

  /** Record the outcome of a run against the rule itself. */
  async markRuleRun(id: string, outcome: 'ok' | 'failed' | 'skipped'): Promise<void> {
    const rule = this.#state.rules.find((r) => r.id === id);
    if (!rule) return;
    rule.lastRunAt = new Date().toISOString();
    rule.lastResult = outcome;
    if (outcome !== 'skipped') rule.runCount += 1;
    await this.#persist();
  }

  // --- scenes ------------------------------------------------------------

  scenes(): Scene[] {
    return structuredClone(this.#state.scenes);
  }

  scene(id: string): Scene | null {
    const found = this.#state.scenes.find((s) => s.id === id);
    return found ? structuredClone(found) : null;
  }

  async saveScene(input: Partial<Scene> & { name: string }): Promise<Scene> {
    const now = new Date().toISOString();
    const existing = input.id ? this.#state.scenes.findIndex((s) => s.id === input.id) : -1;

    if (existing >= 0) {
      const merged: Scene = {
        ...this.#state.scenes[existing]!,
        ...input,
        id: this.#state.scenes[existing]!.id,
        updatedAt: now,
      };
      this.#state.scenes[existing] = merged;
      await this.#persist();
      return structuredClone(merged);
    }

    const scene: Scene = {
      id: input.id ?? newId('scene'),
      name: input.name,
      icon: input.icon ?? '✨',
      actions: input.actions ?? [],
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
    };
    this.#state.scenes.push(scene);
    await this.#persist();
    log.info(`created scene "${scene.name}"`);
    return structuredClone(scene);
  }

  async deleteScene(id: string): Promise<boolean> {
    const before = this.#state.scenes.length;
    this.#state.scenes = this.#state.scenes.filter((s) => s.id !== id);
    if (this.#state.scenes.length === before) return false;
    await this.#persist();
    return true;
  }

  async markSceneRun(id: string): Promise<void> {
    const scene = this.#state.scenes.find((s) => s.id === id);
    if (!scene) return;
    scene.lastRunAt = new Date().toISOString();
    await this.#persist();
  }

  // --- log ---------------------------------------------------------------

  logEntries(limit = 60): LogEntry[] {
    return structuredClone(this.#state.log.slice(0, limit));
  }

  async append(entry: Omit<LogEntry, 'id' | 'at'>): Promise<void> {
    this.#state.log.unshift({ ...entry, id: newId('log'), at: new Date().toISOString() });
    if (this.#state.log.length > LOG_LIMIT) this.#state.log.length = LOG_LIMIT;
    await this.#persist();
  }

  async clearLog(): Promise<void> {
    this.#state.log = [];
    await this.#persist();
  }
}

export const automations = new AutomationStore();
