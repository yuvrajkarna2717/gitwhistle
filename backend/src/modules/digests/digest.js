import { DateTime } from 'luxon';
import { insertDeliveries, activeChannels } from '../notifications/deliveries.js';
import { logger, errSummary } from '../../shared/logger.js';

const FAILED_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];
const DEFAULT_STALE_HOURS = 72;

/** Deterministic aggregation of one workspace's activity in [windowStart, windowEnd). */
export async function buildDigestSummary(db, workspaceId, { windowStart, windowEnd, now = new Date() }) {
  const inWindow = (q) => q.where('e.workspace_id', workspaceId).where('e.occurred_at', '>=', windowStart).where('e.occurred_at', '<', windowEnd);

  const counts = await inWindow(db('events as e'))
    .select('e.event_type')
    .count({ n: '*' })
    .whereIn('e.event_type', ['pull_request.opened', 'pull_request.merged', 'pull_request.closed', 'pull_request_review.submitted', 'issues.opened', 'issues.closed', 'release.published'])
    .groupBy('e.event_type');
  const c = Object.fromEntries(counts.map((r) => [r.event_type, Number(r.n)]));

  const failedRuns = await inWindow(db('events as e'))
    .leftJoin('repositories as r', 'r.id', 'e.repository_id')
    .where('e.event_type', 'workflow_run.completed')
    .whereRaw("e.metadata->>'conclusion' = ANY(?)", [FAILED_CONCLUSIONS])
    .orderBy('e.occurred_at', 'desc')
    .select('e.metadata', 'r.full_name');

  const openPrs = db('pull_requests as p')
    .join('repositories as r', 'r.id', 'p.repository_id')
    .where({ 'p.workspace_id': workspaceId, 'p.state': 'open', 'r.monitoring_enabled': true })
    .whereNull('r.removed_at');

  const stalePolicy = await db('reminder_policies').where({ workspace_id: workspaceId, type: 'stale_pr' }).first('threshold_hours');
  const staleHours = stalePolicy?.threshold_hours || DEFAULT_STALE_HOURS;

  const pending = await openPrs
    .clone()
    .where('p.draft', false)
    .whereIn('p.review_state', ['none', 'commented'])
    .orderByRaw('coalesce(p.review_requested_at, p.gh_created_at) asc')
    .select('p.number', 'p.title', 'p.html_url', 'p.review_requested_at', 'p.gh_created_at', 'r.full_name');
  const stale = await openPrs.clone().where('p.draft', false).where('p.last_activity_at', '<', new Date(now.getTime() - staleHours * 3_600_000)).count({ n: '*' }).first();
  const unassigned = await db('issues as i')
    .join('repositories as r', 'r.id', 'i.repository_id')
    .where({ 'i.workspace_id': workspaceId, 'i.state': 'open', 'r.monitoring_enabled': true })
    .whereNull('r.removed_at')
    .whereRaw("i.assignees = '[]'::jsonb")
    .count({ n: '*' })
    .first();

  return {
    prsOpened: c['pull_request.opened'] || 0,
    prsMerged: c['pull_request.merged'] || 0,
    prsClosed: c['pull_request.closed'] || 0,
    reviewsSubmitted: c['pull_request_review.submitted'] || 0,
    pendingReviews: pending.length,
    stalePrs: Number(stale?.n || 0),
    issuesOpened: c['issues.opened'] || 0,
    issuesClosed: c['issues.closed'] || 0,
    unassignedIssues: Number(unassigned?.n || 0),
    failedWorkflows: failedRuns.length,
    releases: c['release.published'] || 0,
    failedWorkflowList: failedRuns.slice(0, 5).map((r) => ({
      workflowName: r.metadata.workflowName,
      branch: r.metadata.branch,
      url: r.metadata.url,
      repository: r.full_name,
    })),
    oldestPendingReviews: pending.slice(0, 5).map((p) => ({
      number: p.number,
      title: p.title,
      url: p.html_url,
      repository: p.full_name,
      waitingHours: (now - new Date(p.review_requested_at || p.gh_created_at)) / 3_600_000,
    })),
  };
}

/** The digest window for a workspace's local date: [day-1 at digestHour, day at digestHour). */
export function digestWindow(timezone, digestHour, now = DateTime.now()) {
  const local = now.setZone(timezone);
  const end = local.startOf('day').set({ hour: digestHour });
  return { due: local >= end, digestDate: end.toISODate(), windowStart: end.minus({ days: 1 }).toJSDate(), windowEnd: end.toJSDate(), label: end.toFormat('ccc d LLL yyyy') };
}

async function queueDigest(deps, workspace, digestRow, { channels }) {
  const { db, registry } = deps;
  const channelId = [workspace.digest_channel_id, workspace.default_channel_id].find((id) => id && channels.has(id));
  if (!channelId) {
    await db('daily_digests').where({ id: digestRow.id }).update({ status: 'skipped', last_error: 'No active digest channel configured', updated_at: db.fn.now() });
    return null;
  }
  const summary = await buildDigestSummary(db, workspace.id, { windowStart: digestRow.window_start, windowEnd: digestRow.window_end });
  const channel = channels.get(channelId);
  const label = DateTime.fromJSDate(new Date(digestRow.window_end)).setZone(workspace.timezone).toFormat('ccc d LLL yyyy');
  const message = registry.destination(channel.provider).renderDigest({ workspaceName: workspace.name, dateLabel: label, summary });
  const dedupeKey = `digest:${workspace.id}:${digestRow.digest_date}`; // digest_date is an ISO date string
  const [deliveryId] = await insertDeliveries(db, [
    { workspace_id: workspace.id, kind: 'digest', channel_id: channelId, provider: channel.provider, dedupe_key: dedupeKey, message },
  ]);
  const existing = deliveryId ? { id: deliveryId } : await db('notification_deliveries').where({ dedupe_key: dedupeKey }).first('id');
  await db('daily_digests').where({ id: digestRow.id }).update({ status: 'queued', summary, delivery_id: existing?.id ?? null, last_error: null, updated_at: db.fn.now() });
  return deliveryId || null;
}

/** Periodic scan: queue at most one digest per workspace per local date. */
export async function runDigestScan(deps, { now = DateTime.now() } = {}) {
  const { db, queues } = deps;
  const workspaces = await db('workspaces').where({ digest_enabled: true });
  const queued = [];
  for (const w of workspaces) {
    try {
      const win = digestWindow(w.timezone, w.digest_hour, now);
      if (!win.due) continue;
      const [row] = await db('daily_digests')
        .insert({ workspace_id: w.id, digest_date: win.digestDate, window_start: win.windowStart, window_end: win.windowEnd, status: 'pending' })
        .onConflict(['workspace_id', 'digest_date'])
        .ignore()
        .returning('*');
      // Retry a digest that failed while building; never rebuild one that was queued or skipped.
      const digest = row || (await db('daily_digests').where({ workspace_id: w.id, digest_date: win.digestDate, status: 'failed' }).first());
      if (!digest) continue;
      const channels = new Map((await activeChannels(db, w.id)).map((c) => [c.id, c]));
      try {
        const id = await queueDigest(deps, w, { ...digest, digest_date: win.digestDate }, { channels });
        if (id) queued.push(id);
      } catch (err) {
        await db('daily_digests').where({ id: digest.id }).update({ status: 'failed', last_error: err.message.slice(0, 1000), updated_at: db.fn.now() });
        throw err;
      }
    } catch (err) {
      logger.error({ err: errSummary(err), workspaceId: w.id }, 'Digest scan failed for workspace');
    }
  }
  for (const id of queued) await queues.enqueueDelivery(id).catch(() => {});
  return { queued: queued.length };
}
