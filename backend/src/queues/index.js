import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_NAMES = { events: 'gw-events', deliveries: 'gw-deliveries', tasks: 'gw-tasks' };
const ENQUEUE_TIMEOUT_MS = 3000;

export function redisConnection(url, { forWorker = false } = {}) {
  return new IORedis(url, {
    // Workers block on Redis and must never give up; producers should fail fast.
    maxRetriesPerRequest: forWorker ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Producer side of the queues. Job ids are deterministic so the same row is never queued twice
 * while a job for it is waiting, delayed, or active. PostgreSQL row status is the source of truth;
 * BullMQ jobs are removed on completion/failure and the outbox relay can always re-create them.
 */
export function createQueues(config) {
  const connection = redisConnection(config.redisUrl);
  connection.on('error', () => {}); // surfaced through failed enqueues and /readyz instead of crashing
  const events = new Queue(QUEUE_NAMES.events, { connection });
  const deliveries = new Queue(QUEUE_NAMES.deliveries, { connection });
  const tasks = new Queue(QUEUE_NAMES.tasks, { connection });

  const base = { removeOnComplete: true, removeOnFail: true };

  return {
    connection,
    queues: { events, deliveries, tasks },
    enqueueEvent: (deliveryRowId) =>
      withTimeout(
        events.add('process', { deliveryRowId }, {
          ...base,
          jobId: `evt_${deliveryRowId}`,
          attempts: config.worker.eventMaxAttempts,
          backoff: { type: 'exponential', delay: 10_000 },
        }),
        ENQUEUE_TIMEOUT_MS,
        'enqueueEvent',
      ),
    enqueueDelivery: (deliveryId) =>
      withTimeout(
        deliveries.add('send', { deliveryId }, {
          ...base,
          jobId: `dlv_${deliveryId}`,
          attempts: config.worker.deliveryMaxAttempts,
          backoff: { type: 'exponential', delay: 15_000 },
        }),
        ENQUEUE_TIMEOUT_MS,
        'enqueueDelivery',
      ),
    enqueueTask: (name, data, opts = {}) => {
      const key = Object.values(data || {}).join('_');
      return withTimeout(
        tasks.add(name, data, {
          ...base,
          jobId: `${name}_${key}`.replace(/[^A-Za-z0-9_-]/g, '_'),
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          ...opts,
        }),
        ENQUEUE_TIMEOUT_MS,
        'enqueueTask',
      );
    },
    async ping() {
      return withTimeout(connection.ping(), 1000, 'redis ping');
    },
    async close() {
      await Promise.allSettled([events.close(), deliveries.close(), tasks.close()]);
      connection.disconnect();
    },
  };
}
