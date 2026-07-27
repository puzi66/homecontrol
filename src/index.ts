import { engine } from './automations/engine.js';
import { logger } from './logger.js';
import { startServer } from './server.js';

const log = logger('main');

const app = await startServer();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    engine.stop();
    void app.close().then(() => process.exit(0));
  });
}

process.on('unhandledRejection', (reason) => {
  log.error(`unhandled rejection: ${String(reason)}`);
});
