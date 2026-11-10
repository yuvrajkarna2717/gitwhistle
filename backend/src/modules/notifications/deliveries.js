import { DelayedError, UnrecoverableError } from 'bullmq';
import { logger, errSummary } from '../../shared/logger.js';
import { metrics } from '../../shared/metrics.js';

export const RETRY_BASE_MS = 15_000;
export const backoffMs = (attempt, base = RETRY_BASE_MS) => Math.min(base * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1000);

/**
 * Inserts notification delivery rows. The dedupe key is deterministic, so re-running the same
 * input (webhook redelivery, retry, reminder re-scan) can never create a second row/message.
 * Returns ids of rows that were newly created.
 */
export async function insertDeliveries(trx, rows) {
  if (!rows.length) return [];
  // enqueued_at marks the intended enqueue right after commit; the relay only steps in if that fails.
  const stamped = rows.map((r) => ({ enqueued_at: new Date(), ...r }));
  const inserted = await trx('notification_deliveries').insert(stamped).onConflict('dedupe_key').ignore().returning(['id']);
  return inserted.map((r) => r.id);
}

export function eventDedupeKey(eventId, channelId) {
  return `event:${eventId}:${channelId}`;
}

/** Load channels (with their integration) that can currently receive messages. */
export async function activeChannels(db, workspaceId) {
  return db('notification_channels as c')
    .join('integrations as i', 'i.id', 'c.integration_id')
    .where({ 'c.workspace_id': workspaceId, 'c.enabled': true, 'c.is_archived': false, 'i.status': 'active' })
    .select('c.id', 'c.provider', 'c.name');
}

/**
 * Sends one delivery. Called by the delivery worker.
 * Outcomes: sent | skipped (channel/integration unusable) | dead (permanent or exhausted) | retry (throws).
 */
export async function sendDelivery(deps, deliveryId, { job, token } = {}) {
  const { db, registry, config } = deps;
  const maxAttempts = config.worker.deliveryMaxAttempts;

  const [row] = await db('notification_deliveries')
    .where({ id: deliveryId })
    .whereIn('status', ['pending', 'failed', 'sending'])
    .update({ status: 'sending', attempts: db.raw('attempts + 1'), locked_at: db.fn.now(), updated_at: db.fn.now() })
    .returning('*');
  if (!row) return { outcome: 'noop' };

  const channel = await db('notification_channels').where({ id: row.channel_id, workspace_id: row.workspace_id }).first();
  const integration = channel && (await db('integrations').where({ id: channel.integration_id, workspace_id: row.workspace_id }).first());
  if (!channel || !channel.enabled || channel.is_archived || !integration || integration.status !== 'active') {
    await db('notification_deliveries')
      .where({ id: row.id })
      .update({ status: 'skipped', last_error: 'Destination channel or integration is not active', updated_at: db.fn.now() });
    metrics.notificationDeliveries.inc({ provider: row.provider, outcome: 'skipped' });
    return { outcome: 'skipped' };
  }

  const destination = registry.destination(row.provider);
  try {
    const result = await destination.send({ integration, channel, message: row.message });
    await db('notification_deliveries').where({ id: row.id }).update({
      status: 'sent',
      sent_at: db.fn.now(),
      external_message_id: result.externalMessageId ?? null,
      last_error: null,
      updated_at: db.fn.now(),
    });
    metrics.notificationDeliveries.inc({ provider: row.provider, outcome: 'sent' });
    return { outcome: 'sent', externalMessageId: result.externalMessageId };
  } catch (err) {
    const c = destination.classifyError(err);
    const errorText = `${c.kind}: ${c.slackError || err.message}`.slice(0, 1000);
    logger.warn({ deliveryId: row.id, attempt: row.attempts, classification: c, err: errSummary(err) }, 'Notification delivery failed');

    if (c.kind === 'revoked') {
      await db('integrations')
        .where({ id: integration.id })
        .update({ status: 'revoked', last_error: errorText, updated_at: db.fn.now() });
    }
    if (c.kind === 'revoked' || c.kind === 'permanent' || row.attempts >= maxAttempts) {
      await db('notification_deliveries').where({ id: row.id }).update({ status: 'dead', last_error: errorText, updated_at: db.fn.now() });
      metrics.notificationDeliveries.inc({ provider: row.provider, outcome: 'dead' });
      if (job) throw new UnrecoverableError(errorText);
      return { outcome: 'dead', error: errorText };
    }

    const delay = c.kind === 'rate_limited' ? Math.max(c.retryAfterMs, 1000) : backoffMs(row.attempts);
    await db('notification_deliveries').where({ id: row.id }).update({
      status: 'failed',
      last_error: errorText,
      next_attempt_at: new Date(Date.now() + delay),
      updated_at: db.fn.now(),
    });
    metrics.notificationDeliveries.inc({ provider: row.provider, outcome: c.kind === 'rate_limited' ? 'rate_limited' : 'retry' });
    if (job && c.kind === 'rate_limited') {
      // Honour Slack's Retry-After without consuming one of BullMQ's attempts.
      await job.moveToDelayed(Date.now() + delay, token);
      throw new DelayedError();
    }
    if (job) throw err; // BullMQ applies exponential backoff
    return { outcome: 'retry', delayMs: delay, error: errorText };
  }
}

/** Manually requeue a failed/dead delivery (admin action). */
export async function retryDelivery(deps, workspaceId, deliveryId) {
  const { db, queues } = deps;
  const [row] = await db('notification_deliveries')
    .where({ id: deliveryId, workspace_id: workspaceId })
    .whereIn('status', ['failed', 'dead', 'skipped'])
    .update({ status: 'pending', attempts: 0, next_attempt_at: db.fn.now(), last_error: null, updated_at: db.fn.now() })
    .returning(['id']);
  if (!row) return false;
  await queues.enqueueDelivery(row.id).catch(() => {});
  return true;
}
