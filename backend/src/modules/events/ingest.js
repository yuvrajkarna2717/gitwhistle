import { logger, errSummary } from '../../shared/logger.js';
import { metrics } from '../../shared/metrics.js';

/**
 * Durably records a verified webhook delivery, then tries to enqueue it.
 *
 * The webhook_deliveries row is the outbox: if Redis is unavailable (or the process dies) after
 * the INSERT commits, the outbox relay re-enqueues rows still pending. The provider's delivery id
 * is unique, so redeliveries are recognised and never processed twice.
 */
/** PostgreSQL jsonb cannot store U+0000; strip it from strings (e.g. odd commit messages). */
export function stripNullChars(value) {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
  if (Array.isArray(value)) return value.map(stripNullChars);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[stripNullChars(k)] = stripNullChars(v);
    return out;
  }
  return value;
}

export async function recordDelivery({ db, queues }, { provider, deliveryId, eventName, action, installationExternalId, payload, payloadBytes }) {
  payload = stripNullChars(payload);
  // Attribute the delivery to a tenant up front so failed deliveries are visible to that workspace's admins.
  const integration = installationExternalId
    ? await db('integrations').where({ provider, external_id: installationExternalId }).first('id', 'workspace_id')
    : null;
  const [row] = await db('webhook_deliveries')
    .insert({
      workspace_id: integration?.workspace_id ?? null,
      integration_id: integration?.id ?? null,
      provider,
      delivery_id: deliveryId,
      event_name: eventName,
      action: action ?? null,
      installation_external_id: installationExternalId ?? null,
      payload,
      payload_bytes: payloadBytes,
      status: 'pending',
    })
    .onConflict(['provider', 'delivery_id'])
    .ignore()
    .returning(['id']);

  if (!row) {
    metrics.webhooksDuplicate.inc({ provider });
    return { duplicate: true };
  }
  metrics.webhooksReceived.inc({ provider, event: eventName });

  try {
    await queues.enqueueEvent(row.id);
    await db('webhook_deliveries').where({ id: row.id }).update({ enqueued_at: db.fn.now() });
  } catch (err) {
    // Not fatal: the delivery is already durable and the relay will enqueue it.
    logger.warn({ err: errSummary(err), deliveryRowId: row.id }, 'Enqueue failed; outbox relay will retry');
  }
  return { duplicate: false, id: row.id };
}
