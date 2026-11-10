import express from 'express';
import { Worker } from 'bullmq';
import { getConfig } from './config/env.js';
import { createContainer } from './container.js';
import { closeDb } from './database/knex.js';
import { QUEUE_NAMES, redisConnection } from './queues/index.js';
import { createHandlers, SCHEDULES } from './workers/handlers.js';
import { healthRoutes } from './modules/health/routes.js';
import { logger, errSummary } from './shared/logger.js';

let config;
try {
  config = getConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const deps = createContainer({ config });
const handlers = createHandlers(deps);
const connection = redisConnection(config.redisUrl, { forWorker: true });
connection.on('error', (err) => logger.warn({ err: errSummary(err) }, 'Redis connection error'));

// Bounded concurrency per queue keeps DB, GitHub and Slack load predictable.
const workers = [
  new Worker(QUEUE_NAMES.events, handlers.events, { connection, concurrency: config.worker.eventConcurrency }),
  new Worker(QUEUE_NAMES.deliveries, handlers.deliveries, {
    connection,
    concurrency: config.worker.deliveryConcurrency,
    limiter: { max: 20, duration: 1000 }, // stay well under Slack's ~1 msg/sec/channel bursts
  }),
  new Worker(QUEUE_NAMES.tasks, handlers.tasks, { connection, concurrency: 2 }),
];
for (const w of workers) {
  w.on('failed', (job, err) => logger.warn({ queue: w.name, job: job?.name, jobId: job?.id, attempt: job?.attemptsMade, err: errSummary(err) }, 'Job failed'));
  w.on('error', (err) => logger.error({ queue: w.name, err: errSummary(err) }, 'Worker error'));
}

for (const [name, every] of Object.entries(SCHEDULES)) {
  await deps.queues.queues.tasks.upsertJobScheduler(name, { every }, { name, opts: { removeOnComplete: true, removeOnFail: 100 } });
}

const health = express();
health.use(healthRoutes(deps, { service: 'worker' }));
const healthServer = health.listen(config.workerHealthPort, () =>
  logger.info({ port: config.workerHealthPort, schedules: Object.keys(SCHEDULES) }, 'GitWhistle worker started'),
);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Shutting down worker (finishing active jobs)');
  const force = setTimeout(() => process.exit(1), 30_000).unref();
  await Promise.allSettled(workers.map((w) => w.close()));
  healthServer.close();
  await deps.queues.close().catch(() => {});
  connection.disconnect();
  await closeDb().catch(() => {});
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err: errSummary(err) }, 'Unhandled promise rejection'));
