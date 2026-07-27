import { EventEmitter } from 'node:events';
import { scanNetwork } from './discovery/index.js';
import type { ScanOptions, ScanProgress, ScanResult } from './discovery/types.js';
import { logger } from './logger.js';
import { registry } from './registry/store.js';

const log = logger('scan');

/**
 * Owns the single in-flight scan.
 *
 * A scan floods the LAN with probes, so running two at once would both slow
 * things down and make results less reliable. Callers that arrive while a scan
 * is running are attached to the existing one instead of starting another.
 */
class ScanManager extends EventEmitter {
  #running: Promise<ScanResult> | null = null;
  #lastResult: ScanResult | null = null;
  #progressLog: ScanProgress[] = [];

  get isRunning(): boolean {
    return this.#running !== null;
  }

  get lastResult(): ScanResult | null {
    return this.#lastResult;
  }

  /** Progress events for the scan currently running, so late subscribers catch up. */
  get progressLog(): ScanProgress[] {
    return [...this.#progressLog];
  }

  start(options: ScanOptions = {}): Promise<ScanResult> {
    if (this.#running) {
      log.info('scan already running, joining it');
      return this.#running;
    }

    this.#progressLog = [];

    this.#running = (async () => {
      try {
        const result = await scanNetwork(options, (event) => {
          this.#progressLog.push(event);
          this.emit('progress', event);
        });

        // Adopted devices learn their new address here; unseen ones go offline.
        await registry.reconcile(result);
        result.devices = registry.annotate(result.devices);

        this.#lastResult = result;
        return result;
      } catch (err) {
        const message = (err as Error).message;
        log.error(`scan failed: ${message}`);
        const event: ScanProgress = { phase: 'error', message };
        this.#progressLog.push(event);
        this.emit('progress', event);
        throw err;
      } finally {
        this.#running = null;
      }
    })();

    return this.#running;
  }
}

export const scanManager = new ScanManager();
