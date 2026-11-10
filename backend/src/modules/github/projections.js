/**
 * Maintains current pull request, review, and issue state from GitHub objects. The same mappers
 * accept webhook payload objects and REST API objects (GitHub uses the same shape for both).
 *
 * Out-of-order safety: a snapshot is applied only if its updated_at is not older than the stored one.
 */

const logins = (arr) => (Array.isArray(arr) ? arr.map((u) => u?.login).filter(Boolean) : []);
const labelNames = (arr) => (Array.isArray(arr) ? arr.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : []);
const ts = (v) => (v ? new Date(v) : null);

/** Aggregate review state from the latest non-comment review of each reviewer. */
export function computeReviewState(reviews) {
  const latest = new Map();
  const sorted = [...reviews].sort((a, b) => new Date(a.submitted_at || 0) - new Date(b.submitted_at || 0));
  let commented = false;
  for (const r of sorted) {
    const state = String(r.state).toUpperCase();
    if (state === 'COMMENTED') {
      commented = true;
      continue;
    }
    if (state === 'PENDING') continue;
    latest.set(r.reviewer_login, state);
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return commented ? 'commented' : 'none';
}

export async function upsertPullRequest(trx, { workspaceId, repositoryId, pr, activityAt }) {
  const updatedAt = ts(pr.updated_at) || new Date();
  const row = {
    workspace_id: workspaceId,
    repository_id: repositoryId,
    external_id: String(pr.id),
    number: pr.number,
    title: pr.title,
    author_login: pr.user?.login ?? null,
    state: pr.state,
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged || pr.merged_at),
    merged_by: pr.merged_by?.login ?? null,
    merged_at: ts(pr.merged_at),
    closed_at: ts(pr.closed_at),
    base_ref: pr.base?.ref ?? null,
    head_ref: pr.head?.ref ?? null,
    head_sha: pr.head?.sha ?? null,
    html_url: pr.html_url,
    requested_reviewers: JSON.stringify(logins(pr.requested_reviewers)),
    requested_teams: JSON.stringify((pr.requested_teams || []).map((t) => t.slug || t.name).filter(Boolean)),
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    gh_created_at: ts(pr.created_at) || updatedAt,
    gh_updated_at: updatedAt,
    last_activity_at: activityAt ? new Date(Math.max(updatedAt, new Date(activityAt))) : updatedAt,
    updated_at: trx.fn.now(),
  };
  const mergeCols = Object.keys(row).filter((k) => !['workspace_id', 'repository_id', 'number', 'gh_created_at'].includes(k));
  const [saved] = await trx('pull_requests')
    .insert(row)
    .onConflict(['repository_id', 'number'])
    .merge(mergeCols)
    .where('pull_requests.gh_updated_at', '<=', updatedAt)
    .returning(['id']);
  if (saved) return saved.id;
  const existing = await trx('pull_requests').where({ repository_id: repositoryId, number: pr.number }).first('id');
  return existing.id;
}

export async function upsertReview(trx, { workspaceId, pullRequestId, review, dismissed = false }) {
  if (!review?.id) return;
  await trx('pull_request_reviews')
    .insert({
      workspace_id: workspaceId,
      pull_request_id: pullRequestId,
      external_id: String(review.id),
      reviewer_login: review.user?.login ?? null,
      state: dismissed ? 'DISMISSED' : String(review.state || 'COMMENTED').toUpperCase(),
      commit_id: review.commit_id ?? null,
      submitted_at: ts(review.submitted_at),
    })
    .onConflict(['pull_request_id', 'external_id'])
    .merge(['state', 'commit_id', 'submitted_at', 'updated_at']);
}

/** Recompute derived review fields from stored reviews. */
export async function refreshReviewSummary(trx, pullRequestId) {
  const reviews = await trx('pull_request_reviews').where({ pull_request_id: pullRequestId }).select('reviewer_login', 'state', 'submitted_at');
  const lastReview = reviews.reduce((max, r) => (r.submitted_at && (!max || r.submitted_at > max) ? r.submitted_at : max), null);
  await trx('pull_requests')
    .where({ id: pullRequestId })
    .update({ review_state: computeReviewState(reviews), last_review_at: lastReview, updated_at: trx.fn.now() });
}

export async function upsertIssue(trx, { workspaceId, repositoryId, issue }) {
  const updatedAt = ts(issue.updated_at) || new Date();
  const row = {
    workspace_id: workspaceId,
    repository_id: repositoryId,
    external_id: String(issue.id),
    number: issue.number,
    title: issue.title,
    author_login: issue.user?.login ?? null,
    state: issue.state,
    state_reason: issue.state_reason ?? null,
    assignees: JSON.stringify(logins(issue.assignees)),
    labels: JSON.stringify(labelNames(issue.labels)),
    html_url: issue.html_url,
    comments_count: issue.comments ?? 0,
    gh_created_at: ts(issue.created_at) || updatedAt,
    gh_updated_at: updatedAt,
    closed_at: ts(issue.closed_at),
    last_activity_at: updatedAt,
    updated_at: trx.fn.now(),
  };
  const mergeCols = Object.keys(row).filter((k) => !['workspace_id', 'repository_id', 'number', 'gh_created_at'].includes(k));
  await trx('issues')
    .insert(row)
    .onConflict(['repository_id', 'number'])
    .merge(mergeCols)
    .where('issues.gh_updated_at', '<=', updatedAt);
}

/** Apply the state-changing side of a GitHub webhook for a monitored repository. */
export async function applyGitHubProjection(trx, { workspaceId, repositoryId, eventName, payload, occurredAt }) {
  const action = payload.action;
  if (eventName === 'pull_request' && payload.pull_request) {
    const prId = await upsertPullRequest(trx, { workspaceId, repositoryId, pr: payload.pull_request });
    const extra = {};
    if (action === 'synchronize') extra.last_commit_at = new Date(occurredAt);
    if (action === 'review_requested' || action === 'ready_for_review') extra.review_requested_at = new Date(occurredAt);
    if (action === 'opened' && !payload.pull_request.draft) extra.review_requested_at = new Date(occurredAt);
    if (Object.keys(extra).length) await trx('pull_requests').where({ id: prId }).update(extra);
    return;
  }
  if (eventName === 'pull_request_review' && payload.pull_request && payload.review) {
    const prId = await upsertPullRequest(trx, { workspaceId, repositoryId, pr: payload.pull_request, activityAt: payload.review.submitted_at });
    await upsertReview(trx, { workspaceId, pullRequestId: prId, review: payload.review, dismissed: action === 'dismissed' });
    await refreshReviewSummary(trx, prId);
    return;
  }
  if (eventName === 'issues' && payload.issue) {
    await upsertIssue(trx, { workspaceId, repositoryId, issue: payload.issue });
    return;
  }
  if (eventName === 'issue_comment' && payload.issue) {
    const table = payload.issue.pull_request ? 'pull_requests' : 'issues';
    await trx(table)
      .where({ repository_id: repositoryId, number: payload.issue.number })
      .where('last_activity_at', '<', new Date(occurredAt))
      .update({ last_activity_at: new Date(occurredAt) });
  }
}
