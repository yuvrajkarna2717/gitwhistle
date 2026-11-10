import { logger, errSummary } from '../../shared/logger.js';
import { metrics } from '../../shared/metrics.js';

const BATCH = 200;
const REENQUEUE_AFTER = "interval '2 minutes'";
const STUCK_SENDING_AFTER = "interval '10 minutes'";

/**
 * Outbox relay. PostgreSQL commits and Redis enqueues are not atomic, so this periodically
 * (re-)enqueues rows that are due but may have no job: Redis was down at ingest time, the process
 * died between commit and enqueue, or Redis lost its data. Deterministic job ids make it harmless
 * to enqueue a row whose job still exists.
 */
export async function runOutboxRelay({ db, queues }) {
  const result = { events: 0, deliveries: 0, unstuck: 0 };

  // A worker that died mid-send leaves 'sending'. Return those to the retry path (at-least-once).
  result.unstuck = await db('notification_deliveries')
    .where('status', 'sending')
    .where('locked_at', '<', db.raw(`now() - ${STUCK_SENDING_AFTER}`))
    .update({ status: 'failed', last_error: 'Worker stopped during send; retrying', next_attempt_at: db.fn.now() });

  const dueEvents = await db('webhook_deliveries')
    .whereIn('status', ['pending', 'failed'])
    .where('next_attempt_at', '<=', db.fn.now())
    .where((q) => q.whereNull('enqueued_at').orWhere('enqueued_at', '<', db.raw(`now() - ${REENQUEUE_AFTER}`)))
    .orderBy('next_attempt_at')
    .limit(BATCH)
    .select('id');
  for (const { id } of dueEvents) {
    try {
      await queues.enqueueEvent(id);
      await db('webhook_deliveries').where({ id }).update({ enqueued_at: db.fn.now() });
      result.events += 1;
    } catch (err) {
      logger.warn({ err: errSummary(err) }, 'Outbox relay could not enqueue event; will retry');
      break; // Redis is likely down; try again next tick
    }
  }

  const dueDeliveries = await db('notification_deliveries')
    .whereIn('status', ['pending', 'failed'])
    .where('next_attempt_at', '<=', db.fn.now())
    .where((q) => q.whereNull('enqueued_at').orWhere('enqueued_at', '<', db.raw(`now() - ${REENQUEUE_AFTER}`)))
    .orderBy('next_attempt_at')
    .limit(BATCH)
    .select('id');
  for (const { id } of dueDeliveries) {
    try {
      await queues.enqueueDelivery(id);
      await db('notification_deliveries').where({ id }).update({ enqueued_at: db.fn.now() });
      result.deliveries += 1;
    } catch (err) {
      logger.warn({ err: errSummary(err) }, 'Outbox relay could not enqueue delivery; will retry');
      break;
    }
  }

  if (result.events) metrics.outboxRequeued.inc({ kind: 'event' }, result.events);
  if (result.deliveries) metrics.outboxRequeued.inc({ kind: 'delivery' }, result.deliveries);
  return result;
}

/** Retention: drop raw webhook payloads after N days (normalized events are kept). */
export async function purgeOldPayloads(db, days) {
  return db('webhook_deliveries')
    .whereIn('status', ['processed', 'ignored', 'dead'])
    .whereNotNull('payload')
    .where('received_at', '<', db.raw(`now() - (? || ' days')::interval`, [String(days)]))
    .update({ payload: null, payload_purged_at: db.fn.now() });
}
