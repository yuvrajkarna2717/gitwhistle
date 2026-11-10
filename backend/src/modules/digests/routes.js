import express from 'express';
import { ok } from '../../shared/http.js';
import { requireWorkspace } from '../../middleware/workspaceAccess.js';
import { badRequest } from '../../shared/errors.js';
import { randomToken } from '../../shared/crypto.js';
import { audit } from '../../shared/audit.js';
import { buildDigestSummary } from './digest.js';
import { insertDeliveries, sendDelivery, activeChannels } from '../notifications/deliveries.js';

/** /api/v1/workspaces/:workspaceId/digests */
export function digestRoutes(deps) {
  const { db, registry } = deps;
  const router = express.Router({ mergeParams: true });
  const member = requireWorkspace(deps, 'member');
  const admin = requireWorkspace(deps, 'admin');

  router.get('/', member, async (req, res) => {
    const rows = await db('daily_digests').where({ workspace_id: req.workspace.id }).orderBy('digest_date', 'desc').limit(30);
    ok(
      res,
      rows.map((d) => ({ id: d.id, date: d.digest_date, status: d.status, windowStart: d.window_start, windowEnd: d.window_end, summary: d.summary, lastError: d.last_error })),
    );
  });

  /** Summary for the last 24 hours without sending anything. */
  router.get('/preview', member, async (req, res) => {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 24 * 3_600_000);
    ok(res, { windowStart, windowEnd, summary: await buildDigestSummary(db, req.workspace.id, { windowStart, windowEnd }) });
  });

  /** Sends a one-off digest for the last 24 hours to the configured channel (does not affect the daily schedule). */
  router.post('/test', admin, async (req, res) => {
    const channels = new Map((await activeChannels(db, req.workspace.id)).map((c) => [c.id, c]));
    const channelId = [req.workspace.digest_channel_id, req.workspace.default_channel_id].find((id) => id && channels.has(id));
    if (!channelId) throw badRequest('Choose an active digest or default channel first');
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 24 * 3_600_000);
    const summary = await buildDigestSummary(db, req.workspace.id, { windowStart, windowEnd });
    const channel = channels.get(channelId);
    const message = registry.destination(channel.provider).renderDigest({ workspaceName: req.workspace.name, dateLabel: 'last 24 hours (test)', summary });
    const [id] = await insertDeliveries(db, [
      { workspace_id: req.workspace.id, kind: 'digest', channel_id: channelId, provider: channel.provider, dedupe_key: `digest-test:${req.workspace.id}:${randomToken(9)}`, message },
    ]);
    const result = await sendDelivery(deps, id);
    await audit(db, req, { action: 'digest.test_sent', targetType: 'notification_delivery', targetId: id });
    ok(res, { deliveryId: id, summary, ...result });
  });

  return router;
}
