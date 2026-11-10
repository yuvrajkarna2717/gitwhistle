import express from 'express';
import { z } from 'zod';
import { validate, paginationQuery } from '../../shared/validate.js';
import { ok, created, noContent, paginate } from '../../shared/http.js';
import { requireWorkspace } from '../../middleware/workspaceAccess.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { decryptJson, randomToken } from '../../shared/crypto.js';
import { insertDeliveries, sendDelivery, retryDelivery } from './deliveries.js';

export const serializeChannel = (c) => ({
  id: c.id,
  provider: c.provider,
  externalId: c.external_id,
  name: c.name,
  isPrivate: c.is_private,
  enabled: c.enabled,
  integrationId: c.integration_id,
  createdAt: c.created_at,
});

const channelParams = z.object({ channelId: z.uuid() }).loose();

/** /api/v1/workspaces/:workspaceId/channels */
export function channelRoutes(deps) {
  const { db, config, slack } = deps;
  const router = express.Router({ mergeParams: true });
  const member = requireWorkspace(deps, 'member');
  const admin = requireWorkspace(deps, 'admin');

  router.get('/', member, async (req, res) => {
    const rows = await db('notification_channels').where({ workspace_id: req.workspace.id }).orderBy('name');
    ok(res, rows.map(serializeChannel));
  });

  router.post(
    '/',
    admin,
    validate({ body: z.object({ externalIds: z.array(z.string().regex(/^[A-Z0-9]{6,20}$/)).min(1).max(50) }) }),
    async (req, res) => {
      const integration = await db('integrations').where({ workspace_id: req.workspace.id, provider: 'slack', status: 'active' }).first();
      if (!integration) throw badRequest('Connect Slack first');
      const creds = decryptJson(integration.credentials_encrypted, config.encryptionKey);
      // Never trust client-supplied names or ids: re-read them from Slack.
      const available = new Map((await slack.listChannels(creds.botToken)).map((c) => [c.id, c]));
      const unknown = req.validated.body.externalIds.filter((id) => !available.has(id));
      if (unknown.length) throw badRequest('Some channels are not visible to the GitWhistle bot', { unknown });
      const rows = req.validated.body.externalIds.map((id) => ({
        workspace_id: req.workspace.id,
        integration_id: integration.id,
        provider: 'slack',
        external_id: id,
        name: available.get(id).name,
        is_private: available.get(id).isPrivate,
        enabled: true,
      }));
      const saved = await db('notification_channels')
        .insert(rows)
        .onConflict(['integration_id', 'external_id'])
        .merge(['name', 'is_private', 'enabled', 'updated_at'])
        .returning('*');
      const ws = await db('workspaces').where({ id: req.workspace.id }).first('default_channel_id');
      if (!ws.default_channel_id) await db('workspaces').where({ id: req.workspace.id }).update({ default_channel_id: saved[0].id });
      await audit(db, req, { action: 'channels.added', targetType: 'channel', metadata: { names: saved.map((c) => c.name) } });
      created(res, saved.map(serializeChannel));
    },
  );

  router.patch('/:channelId', admin, validate({ params: channelParams, body: z.object({ enabled: z.boolean() }) }), async (req, res) => {
    const [row] = await db('notification_channels')
      .where({ id: req.validated.params.channelId, workspace_id: req.workspace.id })
      .update({ enabled: req.validated.body.enabled, updated_at: db.fn.now() })
      .returning('*');
    if (!row) throw notFound('Channel not found');
    await audit(db, req, { action: 'channel.updated', targetType: 'channel', targetId: row.id, metadata: { enabled: row.enabled } });
    ok(res, serializeChannel(row));
  });

  router.delete('/:channelId', admin, validate({ params: channelParams }), async (req, res) => {
    const n = await db('notification_channels').where({ id: req.validated.params.channelId, workspace_id: req.workspace.id }).del();
    if (!n) throw notFound('Channel not found');
    await audit(db, req, { action: 'channel.removed', targetType: 'channel', targetId: req.validated.params.channelId });
    noContent(res);
  });

  /** Sends a test message through the real delivery path and reports the outcome. */
  router.post('/:channelId/test', admin, validate({ params: channelParams }), async (req, res) => {
    const channel = await db('notification_channels').where({ id: req.validated.params.channelId, workspace_id: req.workspace.id }).first();
    if (!channel) throw notFound('Channel not found');
    const [id] = await insertDeliveries(db, [
      {
        workspace_id: req.workspace.id,
        kind: 'test',
        channel_id: channel.id,
        provider: channel.provider,
        dedupe_key: `test:${channel.id}:${randomToken(9)}`,
        message: {
          text: 'GitWhistle test notification',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `:wave: GitWhistle is connected to this channel for *${req.workspace.name.replace(/[<>&]/g, '')}*.` } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: `Sent by ${req.user.login}` }] },
          ],
        },
      },
    ]);
    const result = await sendDelivery(deps, id);
    ok(res, { deliveryId: id, ...result });
  });

  return router;
}

/** /api/v1/workspaces/:workspaceId/notifications — delivery history */
export function notificationRoutes(deps) {
  const { db } = deps;
  const router = express.Router({ mergeParams: true });
  const member = requireWorkspace(deps, 'member');
  const admin = requireWorkspace(deps, 'admin');

  router.get(
    '/',
    member,
    validate({
      query: paginationQuery.extend({
        status: z.enum(['pending', 'sending', 'sent', 'failed', 'dead', 'skipped']).optional(),
        kind: z.enum(['event', 'reminder', 'digest', 'test']).optional(),
        channelId: z.uuid().optional(),
      }),
    }),
    async (req, res) => {
      const { status, kind, channelId } = req.validated.query;
      const q = db('notification_deliveries as d')
        .join('notification_channels as c', 'c.id', 'd.channel_id')
        .leftJoin('events as e', 'e.id', 'd.event_id')
        .where('d.workspace_id', req.workspace.id)
        .modify((qb) => {
          if (status) qb.where('d.status', status);
          if (kind) qb.where('d.kind', kind);
          if (channelId) qb.where('d.channel_id', channelId);
        })
        .orderBy('d.created_at', 'desc')
        .select('d.id', 'd.kind', 'd.status', 'd.priority', 'd.attempts', 'd.last_error', 'd.sent_at', 'd.created_at', 'd.event_id', 'd.message', 'c.name as channel_name', 'c.id as channel_id', 'e.event_type', 'e.title as event_title');
      const { rows, meta } = await paginate(q, req.validated.query);
      ok(
        res,
        rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          priority: r.priority,
          attempts: r.attempts,
          lastError: r.last_error,
          sentAt: r.sent_at,
          createdAt: r.created_at,
          channel: { id: r.channel_id, name: r.channel_name },
          eventId: r.event_id,
          eventType: r.event_type,
          summary: r.message?.text ?? r.event_title,
        })),
        meta,
      );
    },
  );

  router.post('/:deliveryId/retry', admin, validate({ params: z.object({ deliveryId: z.uuid() }).loose() }), async (req, res) => {
    const okRetry = await retryDelivery(deps, req.workspace.id, req.validated.params.deliveryId);
    if (!okRetry) throw notFound('No failed delivery with that id');
    await audit(db, req, { action: 'notification.retried', targetType: 'notification_delivery', targetId: req.validated.params.deliveryId });
    ok(res, { queued: true });
  });

  return router;
}
