import express from 'express';
import { ok } from '../../shared/http.js';
import { requireWorkspace } from '../../middleware/workspaceAccess.js';
import { pullRequestSummary } from '../pull-requests/routes.js';
import { issueSummary } from '../issues/routes.js';
import { serializeIntegration } from '../integrations/routes.js';
import { eventFromRow } from '../events/processor.js';

/** /api/v1/workspaces/:workspaceId/overview — every number here comes from stored data. */
export function overviewRoutes(deps) {
  const { db } = deps;
  const router = express.Router({ mergeParams: true });

  router.get('/', requireWorkspace(deps, 'member'), async (req, res) => {
    const wsId = req.workspace.id;
    const [integrations, repoCounts, prs, issues, failedRow, recentEvents, recentDeliveries, deliveryHealth] = await Promise.all([
      db('integrations').where({ workspace_id: wsId }),
      db('repositories')
        .where({ workspace_id: wsId })
        .whereNull('removed_at')
        .first(db.raw('count(*)::int as total'), db.raw('count(*) filter (where monitoring_enabled)::int as monitored')),
      pullRequestSummary(db, wsId),
      issueSummary(db, wsId),
      db('events')
        .where({ workspace_id: wsId, event_type: 'workflow_run.completed' })
        .where('occurred_at', '>', db.raw("now() - interval '7 days'"))
        .whereRaw("metadata->>'conclusion' in ('failure','timed_out','startup_failure')")
        .count({ n: '*' })
        .first(),
      db('events as e')
        .leftJoin('repositories as r', 'r.id', 'e.repository_id')
        .where('e.workspace_id', wsId)
        .orderBy('e.occurred_at', 'desc')
        .limit(10)
        .select('e.*', 'r.full_name as repo_full_name'),
      db('notification_deliveries as d')
        .join('notification_channels as c', 'c.id', 'd.channel_id')
        .where('d.workspace_id', wsId)
        .orderBy('d.created_at', 'desc')
        .limit(10)
        .select('d.id', 'd.kind', 'd.status', 'd.created_at', 'd.sent_at', 'd.last_error', 'c.name as channel_name', db.raw("d.message->>'text' as summary")),
      db('notification_deliveries')
        .where({ workspace_id: wsId })
        .where('created_at', '>', db.raw("now() - interval '7 days'"))
        .first(
          db.raw("count(*) filter (where status = 'sent')::int as sent"),
          db.raw("count(*) filter (where status in ('failed','dead'))::int as failed"),
          db.raw("count(*) filter (where status in ('pending','sending'))::int as pending"),
        ),
    ]);

    const byProvider = (p) => integrations.filter((i) => i.provider === p).map(serializeIntegration);
    ok(res, {
      github: byProvider('github'),
      slack: byProvider('slack'),
      repositories: repoCounts,
      pullRequests: prs,
      issues,
      failedWorkflows7d: Number(failedRow?.n || 0),
      deliveries7d: deliveryHealth,
      recentEvents: recentEvents.map((r) => eventFromRow(r)),
      recentNotifications: recentDeliveries.map((d) => ({
        id: d.id,
        kind: d.kind,
        status: d.status,
        channelName: d.channel_name,
        summary: d.summary,
        createdAt: d.created_at,
        sentAt: d.sent_at,
        lastError: d.last_error,
      })),
    });
  });

  return router;
}
