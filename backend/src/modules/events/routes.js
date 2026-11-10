import express from 'express';
import { z } from 'zod';
import { validate, paginationQuery } from '../../shared/validate.js';
import { ok, paginate } from '../../shared/http.js';
import { requireWorkspace } from '../../middleware/workspaceAccess.js';
import { notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { eventFromRow, reprocessDelivery } from './processor.js';

const csv = z
  .string()
  .max(1000)
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.string().regex(/^[a-z_]+(\.[a-z_]+)?$/)).max(30));

/** /api/v1/workspaces/:workspaceId/events (activity feed) and /webhook-deliveries (admin) */
export function eventRoutes(deps) {
  const { db } = deps;
  const router = express.Router({ mergeParams: true });
  const member = requireWorkspace(deps, 'member');
  const admin = requireWorkspace(deps, 'admin');

  router.get(
    '/events',
    member,
    validate({
      query: paginationQuery.extend({
        eventType: csv.optional(),
        repositoryId: z.uuid().optional(),
        actor: z.string().trim().max(100).optional(),
        status: z.enum(['open', 'closed', 'merged', 'success', 'failure']).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      }),
    }),
    async (req, res) => {
      const { eventType, repositoryId, actor, status, from, to } = req.validated.query;
      const q = db('events as e')
        .leftJoin('repositories as r', 'r.id', 'e.repository_id')
        .where('e.workspace_id', req.workspace.id)
        .modify((qb) => {
          if (eventType?.length) {
            qb.where((w) => {
              for (const t of eventType) t.includes('.') ? w.orWhere('e.event_type', t) : w.orWhere('e.event_type', 'like', `${t}.%`).orWhere('e.event_type', t);
            });
          }
          if (repositoryId) qb.where('e.repository_id', repositoryId);
          if (actor) qb.whereRaw('lower(e.actor_login) = lower(?)', [actor]);
          if (status === 'success' || status === 'failure') qb.whereRaw("e.metadata->>'conclusion' = ?", [status]);
          else if (status) qb.whereRaw("e.metadata->>'state' = ?", [status]);
          if (from) qb.where('e.occurred_at', '>=', from);
          if (to) qb.where('e.occurred_at', '<', to);
        })
        .orderBy('e.occurred_at', 'desc')
        .select('e.*', 'r.full_name as repo_full_name');
      const { rows, meta } = await paginate(q, req.validated.query);
      ok(res, rows.map((r) => eventFromRow(r)), meta);
    },
  );

  router.get('/events/types', member, async (req, res) => {
    const rows = await db('events').where({ workspace_id: req.workspace.id }).distinct('event_type').orderBy('event_type');
    ok(res, rows.map((r) => r.event_type));
  });

  router.get('/events/actors', member, async (req, res) => {
    const rows = await db('events')
      .where({ workspace_id: req.workspace.id })
      .whereNotNull('actor_login')
      .where('occurred_at', '>', db.raw("now() - interval '90 days'"))
      .distinct('actor_login')
      .orderBy('actor_login')
      .limit(500);
    ok(res, rows.map((r) => r.actor_login));
  });

  router.get('/events/:eventId', member, validate({ params: z.object({ eventId: z.uuid() }).loose() }), async (req, res) => {
    const row = await db('events as e')
      .leftJoin('repositories as r', 'r.id', 'e.repository_id')
      .where({ 'e.id': req.validated.params.eventId, 'e.workspace_id': req.workspace.id })
      .first('e.*', 'r.full_name as repo_full_name');
    if (!row) throw notFound('Event not found');
    const deliveries = await db('notification_deliveries as d')
      .join('notification_channels as c', 'c.id', 'd.channel_id')
      .where({ 'd.event_id': row.id, 'd.workspace_id': req.workspace.id })
      .select('d.id', 'd.status', 'd.attempts', 'd.last_error', 'd.sent_at', 'd.rule_ids', 'c.name as channel_name');
    ok(res, {
      ...eventFromRow(row),
      deliveries: deliveries.map((d) => ({ id: d.id, status: d.status, attempts: d.attempts, lastError: d.last_error, sentAt: d.sent_at, ruleIds: d.rule_ids, channelName: d.channel_name })),
    });
  });

  router.get(
    '/webhook-deliveries',
    admin,
    validate({ query: paginationQuery.extend({ status: z.enum(['pending', 'processing', 'processed', 'ignored', 'failed', 'dead']).optional() }) }),
    async (req, res) => {
      const q = db('webhook_deliveries')
        .where({ workspace_id: req.workspace.id })
        .modify((qb) => req.validated.query.status && qb.where('status', req.validated.query.status))
        .orderBy('received_at', 'desc')
        .select('id', 'provider', 'delivery_id', 'event_name', 'action', 'status', 'attempts', 'last_error', 'ignore_reason', 'received_at', 'processed_at', 'next_attempt_at', 'payload_bytes');
      const { rows, meta } = await paginate(q, req.validated.query);
      ok(
        res,
        rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          deliveryId: r.delivery_id,
          event: r.action ? `${r.event_name}.${r.action}` : r.event_name,
          status: r.status,
          attempts: r.attempts,
          lastError: r.last_error,
          ignoreReason: r.ignore_reason,
          receivedAt: r.received_at,
          processedAt: r.processed_at,
          nextAttemptAt: r.next_attempt_at,
          payloadBytes: r.payload_bytes,
        })),
        meta,
      );
    },
  );

  router.post('/webhook-deliveries/:deliveryId/reprocess', admin, validate({ params: z.object({ deliveryId: z.uuid() }).loose() }), async (req, res) => {
    const done = await reprocessDelivery(deps, req.workspace.id, req.validated.params.deliveryId);
    if (!done) throw notFound('No failed, dead, or ignored delivery with that id (or its payload was purged)');
    await audit(db, req, { action: 'webhook.reprocessed', targetType: 'webhook_delivery', targetId: req.validated.params.deliveryId });
    ok(res, { queued: true });
  });

  return router;
}
