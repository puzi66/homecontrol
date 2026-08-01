import { EventEmitter } from 'node:events';
import { scanNetwork } from './discovery/index.js';
import type { ScanOptions, ScanProgress, ScanResult } from './discovery/types.js';
import { logger } from './logger.js';
import { seen } from './registry/seen.js';
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

  /**
   * What to show the dashboard. Falls back to the persisted ledger, so the
   * device list is populated immediately after a restart rather than empty
   * until someone runs a scan.
   */
  discoveredDevices(): { devices: ReturnType<typeof seen.asDiscovered>; fromLedger: boolean } {
    if (this.#lastResult) {
      return { devices: this.#lastResult.devices, fromLedger: false };
    }
    const adopted = new Set(registry.list().map((d) => d.id));
    return { devices: seen.asDiscovered(adopted), fromLedger: true };
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
          // The orchestrator knows nothing about the registry, so it reports
          // every device as unadopted. Both the streamed devices and the final
          // result need fixing before they go out: the `done` event is emitted
          // from inside the scan, which is before this function gets the result
          // back and can annotate it. Miss either and the "hide adopted" filter
          // has nothing to act on.
          let annotated: ScanProgress = event;
          if (event.phase === 'device') {
            annotated = { ...event, device: registry.annotate([event.device])[0]! };
          } else if (event.phase === 'done') {
            annotated = {
              ...event,
              result: { ...event.result, devices: registry.annotate(event.result.devices) },
            };
          }

          this.#progressLog.push(annotated);
          this.emit('progress', annotated);
        });

        // Adopted devices learn their new address here; unseen ones go offline.
        await registry.reconcile(result);

        // Everything the scan saw goes into the ledger, adopted or not, so a
        // restart does not throw away the picture of the network.
        await seen.merge(result);

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
