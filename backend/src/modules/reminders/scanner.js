import { reminderCandidate, reminderDedupeKey } from './policies.js';
import { refreshPullRequestFromGitHub } from '../github/installations.js';
import { insertDeliveries, activeChannels } from '../notifications/deliveries.js';
import { logger, errSummary } from '../../shared/logger.js';

const MAX_REFRESH_PER_WORKSPACE = 25;
const FRESH_ENOUGH_MS = 30 * 60 * 1000;

/**
 * Periodic scan: for each enabled reminder policy, find qualifying open PRs, confirm the state
 * against GitHub (webhooks can be missed), then create deduplicated reminder deliveries.
 */
export async function runReminderScan(deps, { now = Date.now() } = {}) {
  const { db, registry, queues } = deps;
  const policies = await db('reminder_policies as p')
    .join('workspaces as w', 'w.id', 'p.workspace_id')
    .where('p.enabled', true)
    .select('p.*', 'w.default_channel_id as workspace_channel_id');

  const byWorkspace = new Map();
  for (const p of policies) {
    if (!byWorkspace.has(p.workspace_id)) byWorkspace.set(p.workspace_id, []);
    byWorkspace.get(p.workspace_id).push(p);
  }

  const created = [];
  for (const [workspaceId, wsPolicies] of byWorkspace) {
    const channels = new Map((await activeChannels(db, workspaceId)).map((c) => [c.id, c]));
    if (!channels.size) continue;
    const minThreshold = Math.min(...wsPolicies.map((p) => p.threshold_hours));
    const prs = await db('pull_requests as pr')
      .join('repositories as r', 'r.id', 'pr.repository_id')
      .where({ 'pr.workspace_id': workspaceId, 'pr.state': 'open', 'r.monitoring_enabled': true })
      .whereNull('r.removed_at')
      .where('pr.gh_created_at', '<', new Date(now - minThreshold * 3_600_000))
      .orderBy('pr.last_activity_at')
      .limit(500)
      .select('pr.*', 'r.full_name as repo_full_name', 'r.default_channel_id as repo_channel_id');

    let refreshed = 0;
    for (let pr of prs) {
      const due = wsPolicies.filter((p) => {
        const c = reminderCandidate(p.type, pr, { now });
        return c && c.waitingHours >= p.threshold_hours;
      });
      if (!due.length) continue;

      // Authoritative check before nagging anyone.
      const stale = !pr.synced_at || now - new Date(pr.synced_at).getTime() > FRESH_ENOUGH_MS;
      if (stale) {
        if (refreshed >= MAX_REFRESH_PER_WORKSPACE) continue;
        refreshed += 1;
        try {
          const fresh = await refreshPullRequestFromGitHub(deps, pr.id);
          if (!fresh) continue;
          pr = { ...pr, ...fresh };
        } catch (err) {
          logger.warn({ err: errSummary(err), pullRequestId: pr.id }, 'Could not refresh PR from GitHub; skipping reminder this cycle');
          continue;
        }
      }

      const rows = [];
      for (const policy of due) {
        const candidate = reminderCandidate(policy.type, pr, { now });
        if (!candidate || candidate.waitingHours < policy.threshold_hours) continue;
        const channelId = [policy.channel_id, pr.repo_channel_id, policy.workspace_channel_id].find((id) => id && channels.has(id));
        if (!channelId) continue;
        const channel = channels.get(channelId);
        rows.push({
          workspace_id: workspaceId,
          kind: 'reminder',
          channel_id: channelId,
          provider: channel.provider,
          dedupe_key: reminderDedupeKey(policy.type, pr.id, candidate, policy),
          message: registry.destination(channel.provider).renderReminder({
            type: policy.type,
            pr,
            repoFullName: pr.repo_full_name,
            waitingHours: candidate.waitingHours,
          }),
        });
      }
      created.push(...(await insertDeliveries(db, rows)));
    }
  }

  for (const id of created) await queues.enqueueDelivery(id).catch(() => {});
  return { created: created.length };
}
