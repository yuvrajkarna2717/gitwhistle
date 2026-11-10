import { sha256 } from '../../shared/crypto.js';

export const REMINDER_TYPES = ['review_pending', 'changes_requested', 'stale_pr'];

/** Created (disabled) for every new workspace so admins only need to switch them on. */
export const DEFAULT_REMINDER_POLICIES = [
  { type: 'review_pending', enabled: false, threshold_hours: 24, repeat_hours: 24 },
  { type: 'changes_requested', enabled: false, threshold_hours: 48, repeat_hours: null },
  { type: 'stale_pr', enabled: false, threshold_hours: 72, repeat_hours: 72 },
];

const hoursSince = (d, now) => (now - new Date(d).getTime()) / 3_600_000;
const sortedJson = (v) => JSON.stringify([...(v || [])].sort());

/**
 * Decides whether a PR currently qualifies for a reminder type.
 * @returns null or { waitingSince, waitingHours, fingerprint }
 *
 * The fingerprint captures the state that makes a reminder meaningful. The same state never
 * produces a second reminder unless repeat_hours elapses (which advances the cycle number).
 */
export function reminderCandidate(type, pr, { now = Date.now() } = {}) {
  if (pr.state !== 'open' || pr.merged) return null;
  switch (type) {
    case 'review_pending': {
      if (pr.draft) return null;
      if (!['none', 'commented'].includes(pr.review_state)) return null;
      const since = pr.review_requested_at || pr.gh_created_at;
      return { waitingSince: since, waitingHours: hoursSince(since, now), fingerprint: `${pr.head_sha}|${sortedJson(pr.requested_reviewers)}|${sortedJson(pr.requested_teams)}|${new Date(since).toISOString()}` };
    }
    case 'changes_requested': {
      if (pr.review_state !== 'changes_requested' || !pr.last_review_at) return null;
      // If the author pushed after the review, the ball is back with reviewers.
      if (pr.last_commit_at && new Date(pr.last_commit_at) > new Date(pr.last_review_at)) return null;
      return { waitingSince: pr.last_review_at, waitingHours: hoursSince(pr.last_review_at, now), fingerprint: `${new Date(pr.last_review_at).toISOString()}|${pr.head_sha}` };
    }
    case 'stale_pr': {
      if (pr.draft) return null;
      return { waitingSince: pr.last_activity_at, waitingHours: hoursSince(pr.last_activity_at, now), fingerprint: new Date(pr.last_activity_at).toISOString() };
    }
    default:
      return null;
  }
}

export function reminderDedupeKey(type, pullRequestId, candidate, policy) {
  const over = candidate.waitingHours - policy.threshold_hours;
  const cycle = policy.repeat_hours ? Math.max(0, Math.floor(over / policy.repeat_hours)) : 0;
  return `reminder:${type}:${pullRequestId}:${sha256(candidate.fingerprint).slice(0, 20)}:${cycle}`;
}

export function serializePolicy(p) {
  return { id: p.id, type: p.type, enabled: p.enabled, thresholdHours: p.threshold_hours, repeatHours: p.repeat_hours, channelId: p.channel_id, updatedAt: p.updated_at };
}
