import { UnrecoverableError } from 'bullmq';
import { handleInstallationWebhook, upsertRepositories } from '../github/installations.js';
import { applyGitHubProjection } from '../github/projections.js';
import { evaluateRules } from '../rules/engine.js';
import { insertDeliveries, eventDedupeKey, activeChannels, backoffMs } from '../notifications/deliveries.js';
import { logger, errSummary } from '../../shared/logger.js';
import { metrics } from '../../shared/metrics.js';

export const EVENT_RETRY_BASE_MS = 10_000;

export function serializeRule(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    priority: r.priority,
    matchMode: r.match_mode,
    conditions: r.conditions,
    actions: r.actions,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Canonical event shape from a stored events row (used for routing, previews, and rendering). */
export function eventFromRow(row, repoFullName) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    source: row.source,
    eventType: row.event_type,
    providerEventId: row.provider_event_id,
    repository: row.repository_id ? { id: row.repository_id, fullName: repoFullName ?? row.repo_full_name ?? null } : null,
    actor: { login: row.actor_login, externalId: row.actor_external_id },
    resource: { type: row.resource_type, externalId: row.resource_external_id, number: row.resource_number, title: row.title, url: row.url },
    metadata: row.metadata,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
  };
}

/** Evaluate rules for a stored event and create delivery rows (inside the caller's transaction). */
export async function routeEvent(trx, deps, { workspace, repository, event }) {
  const rules = (await trx('notification_rules').where({ workspace_id: workspace.id, enabled: true })).map(serializeRule);
  const channels = await activeChannels(trx, workspace.id);
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const routing = evaluateRules(event, rules, {
    fallback: {
      enabled: workspace.fallback_routing_enabled,
      channelId: repository?.default_channel_id || workspace.default_channel_id,
    },
    activeChannelIds: new Set(channelById.keys()),
  });

  const rows = routing.channels.map(({ channelId, ruleIds }) => {
    const channel = channelById.get(channelId);
    const message = deps.registry.destination(channel.provider).renderEvent(event, { priority: routing.priority });
    return {
      workspace_id: workspace.id,
      kind: 'event',
      event_id: event.id,
      channel_id: channelId,
      provider: channel.provider,
      dedupe_key: eventDedupeKey(event.id, channelId),
      priority: routing.priority,
      rule_ids: JSON.stringify(ruleIds),
      message,
    };
  });
  const ids = await insertDeliveries(trx, rows);
  return { routing, deliveryIds: ids };
}

async function recordAttempt(db, deliveryId, attempt, startedAt, outcome, error) {
  await db('event_processing_attempts').insert({
    webhook_delivery_id: deliveryId,
    attempt,
    outcome,
    error: error ? String(error).slice(0, 2000) : null,
    started_at: startedAt,
  });
}

/**
 * Processes one stored webhook delivery. Safe to run more than once for the same delivery:
 *  - the delivery row is locked (FOR UPDATE SKIP LOCKED) for the whole transaction;
 *  - canonical events are unique per provider delivery id;
 *  - notification deliveries are unique per (event, channel);
 *  - the delivery is marked processed in the SAME transaction as its effects, so it is never
 *    marked processed unless those effects committed.
 */
export async function processWebhookDelivery(deps, deliveryRowId, { throwOnRetry = true } = {}) {
  const { db, registry, queues, config } = deps;
  const startedAt = new Date();
  const maxAttempts = config.worker.eventMaxAttempts;
  let attempt = 0;
  let followUps = { tasks: [], deliveryIds: [] };

  try {
    const result = await db.transaction(async (trx) => {
      const delivery = await trx('webhook_deliveries').where({ id: deliveryRowId }).forUpdate().skipLocked().first();
      if (!delivery) return { outcome: 'locked_or_missing' };
      if (['processed', 'ignored', 'dead'].includes(delivery.status)) return { outcome: 'already_done' };
      if (!delivery.payload) {
        await trx('webhook_deliveries').where({ id: delivery.id }).update({ status: 'dead', last_error: 'Payload purged before processing' });
        return { outcome: 'dead' };
      }
      attempt = delivery.attempts + 1;
      await trx('webhook_deliveries').where({ id: delivery.id }).update({ status: 'processing', attempts: attempt, locked_at: trx.fn.now() });

      const source = registry.source(delivery.provider);
      const payload = delivery.payload;
      const finish = async (status, extra = {}) => {
        await trx('webhook_deliveries')
          .where({ id: delivery.id })
          .update({ status, processed_at: trx.fn.now(), locked_at: null, last_error: null, next_attempt_at: trx.fn.now(), ...extra });
      };

      // 1. Lifecycle events (installations, repository metadata).
      if (source.isLifecycleEvent(delivery.event_name)) {
        const r = await handleInstallationWebhook(trx, deps, { eventName: delivery.event_name, payload });
        followUps.tasks = r.tasks;
        await finish(r.ignoredReason ? 'ignored' : 'processed', {
          ignore_reason: r.ignoredReason ?? null,
          workspace_id: r.workspaceId ?? null,
          integration_id: r.integrationId ?? null,
        });
        return { outcome: r.ignoredReason ? 'ignored' : 'processed' };
      }

      // 2. Resolve tenant via the installation that sent it.
      const integration = delivery.installation_external_id
        ? await trx('integrations').where({ provider: delivery.provider, external_id: delivery.installation_external_id }).first()
        : null;
      if (!integration || !integration.workspace_id) {
        await finish('ignored', { ignore_reason: 'installation not linked to a workspace' });
        return { outcome: 'ignored' };
      }
      if (integration.status !== 'active') {
        await finish('ignored', { ignore_reason: `installation ${integration.status}`, workspace_id: integration.workspace_id });
        return { outcome: 'ignored' };
      }
      const workspace = await trx('workspaces').where({ id: integration.workspace_id }).first();

      // 3. Normalize. Unsupported event/action combinations are recorded and ignored.
      const canonical = source.normalize(delivery.event_name, payload, { receivedAt: new Date(delivery.received_at).toISOString() });
      if (!canonical) {
        await finish('ignored', { ignore_reason: 'event type not supported', workspace_id: workspace.id, integration_id: integration.id });
        return { outcome: 'ignored' };
      }

      // 4. Repository must be known and monitored. New repos (created after sync) are added on the fly.
      let repository = null;
      if (canonical.repository) {
        repository = await trx('repositories').where({ integration_id: integration.id, external_id: canonical.repository.externalId }).first();
        if (!repository && payload.repository) {
          await upsertRepositories(trx, integration, [payload.repository]);
          repository = await trx('repositories').where({ integration_id: integration.id, external_id: canonical.repository.externalId }).first();
        }
        if (!repository || repository.removed_at || !repository.monitoring_enabled) {
          await finish('ignored', { ignore_reason: 'repository not monitored', workspace_id: workspace.id, integration_id: integration.id });
          return { outcome: 'ignored' };
        }
      }

      // 5. Persist canonical event (idempotent on provider delivery id).
      const [inserted] = await trx('events')
        .insert({
          workspace_id: workspace.id,
          source: canonical.source,
          event_type: canonical.eventType,
          provider_event_id: delivery.delivery_id,
          webhook_delivery_id: delivery.id,
          repository_id: repository?.id ?? null,
          actor_login: canonical.actor?.login ?? null,
          actor_external_id: canonical.actor?.externalId ?? null,
          resource_type: canonical.resource?.type ?? null,
          resource_external_id: canonical.resource?.externalId ?? null,
          resource_number: canonical.resource?.number ?? null,
          title: canonical.resource?.title ?? null,
          url: canonical.resource?.url ?? null,
          metadata: canonical.metadata,
          occurred_at: canonical.occurredAt,
          received_at: delivery.received_at,
        })
        .onConflict(['source', 'provider_event_id'])
        .ignore()
        .returning('*');
      const eventRow = inserted || (await trx('events').where({ source: canonical.source, provider_event_id: delivery.delivery_id }).first());
      const event = eventFromRow(eventRow, repository?.full_name);

      // 6. Update PR / issue state.
      if (repository) {
        await applyGitHubProjection(trx, {
          workspaceId: workspace.id,
          repositoryId: repository.id,
          eventName: delivery.event_name,
          payload,
          occurredAt: canonical.occurredAt,
        });
      }

      // 7. Route to destinations.
      const { deliveryIds } = await routeEvent(trx, deps, { workspace, repository, event });
      followUps.deliveryIds = deliveryIds;

      await finish('processed', { workspace_id: workspace.id, integration_id: integration.id });
      return { outcome: 'processed', eventId: event.id, deliveries: deliveryIds.length };
    });

    if (attempt > 0) await recordAttempt(db, deliveryRowId, attempt, startedAt, 'success');
    if (result.outcome === 'processed' || result.outcome === 'ignored') {
      metrics.eventsProcessed.inc({ provider: 'github', outcome: result.outcome });
      const d = await db('webhook_deliveries').where({ id: deliveryRowId }).first('received_at');
      if (d) metrics.processingLatency.observe((Date.now() - new Date(d.received_at).getTime()) / 1000);
    }

    // After commit: enqueue follow-up work. Failures here are recovered by the outbox relay.
    for (const id of followUps.deliveryIds) {
      await queues.enqueueDelivery(id).catch((err) => logger.warn({ err: errSummary(err), id }, 'Delivery enqueue failed; relay will retry'));
    }
    for (const t of followUps.tasks) {
      await queues.enqueueTask(t.name, t.data).catch((err) => logger.warn({ err: errSummary(err), task: t.name }, 'Task enqueue failed'));
    }
    return result;
  } catch (err) {
    const message = `${err.name}: ${err.message}`.slice(0, 2000);
    const current = await db('webhook_deliveries').where({ id: deliveryRowId }).first('attempts');
    // The transaction rolled back, so the attempt counter increment was lost; persist it now.
    attempt = Math.max(attempt, (current?.attempts ?? 0) + 1);
    const final = attempt >= maxAttempts;
    await db('webhook_deliveries')
      .where({ id: deliveryRowId })
      .update({
        status: final ? 'dead' : 'failed',
        attempts: attempt,
        last_error: message,
        locked_at: null,
        next_attempt_at: new Date(Date.now() + backoffMs(attempt, EVENT_RETRY_BASE_MS)),
      });
    await recordAttempt(db, deliveryRowId, attempt, startedAt, 'error', message);
    metrics.eventsFailed.inc({ provider: 'github', final: String(final) });
    logger.error({ err: errSummary(err), deliveryRowId, attempt, final }, 'Webhook processing failed');
    if (!throwOnRetry) return { outcome: final ? 'dead' : 'failed', error: message };
    if (final) throw new UnrecoverableError(message);
    throw err;
  }
}

/** Admin action: put a failed/dead/ignored delivery back into the pipeline. */
export async function reprocessDelivery(deps, workspaceId, deliveryRowId) {
  const { db, queues } = deps;
  const [row] = await db('webhook_deliveries')
    .where({ id: deliveryRowId, workspace_id: workspaceId })
    .whereIn('status', ['failed', 'dead', 'ignored'])
    .whereNotNull('payload')
    .update({ status: 'pending', attempts: 0, last_error: null, ignore_reason: null, next_attempt_at: db.fn.now() })
    .returning(['id']);
  if (!row) return false;
  await queues.enqueueEvent(row.id).catch(() => {});
  return true;
}
