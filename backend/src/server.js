import { getConfig } from './config/env.js';
import { createContainer } from './container.js';
import { createApp } from './app.js';
import { closeDb } from './database/knex.js';
import { logger, errSummary } from './shared/logger.js';

let config;
try {
  config = getConfig();
} catch (err) {
  // Configuration errors are printed plainly so they are readable without a log viewer.
  console.error(err.message);
  process.exit(1);
}

const deps = createContainer({ config });
const app = createApp(deps);
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, github: config.github.enabled, slack: config.slack.enabled }, 'GitWhistle API listening');
});
server.keepAliveTimeout = 65_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down API');
  const force = setTimeout(() => process.exit(1), 15_000).unref();
  server.close(async () => {
    await deps.queues.close().catch(() => {});
    await closeDb().catch(() => {});
    clearTimeout(force);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err: errSummary(err) }, 'Unhandled promise rejection'));
