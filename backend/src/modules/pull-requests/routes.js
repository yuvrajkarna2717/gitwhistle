import express from 'express';
import { z } from 'zod';
import { validate, paginationQuery } from '../../shared/validate.js';
import { ok, paginate } from '../../shared/http.js';
import { requireWorkspace } from '../../middleware/workspaceAccess.js';
import { notFound } from '../../shared/errors.js';
import { refreshPullRequestFromGitHub } from '../github/installations.js';

const DEFAULT_STALE_HOURS = 72;

/** SQL fragments for derived PR status, shared by list filters, counts, and the overview. */
export const PR_STATUS_SQL = {
  waitingForAuthor: "p.review_state = 'changes_requested' AND (p.last_commit_at IS NULL OR p.last_commit_at <= p.last_review_at)",
  waitingForReview:
    "p.draft = false AND (p.review_state IN ('none','commented') OR (p.review_state = 'changes_requested' AND p.last_commit_at > p.last_review_at))",
  approved: "p.review_state = 'approved'",
};

export function derivePrStatus(p) {
  if (p.merged) return 'merged';
  if (p.state === 'closed') return 'closed';
  if (p.draft) return 'draft';
  if (p.review_state === 'approved') return 'approved';
  if (p.review_state === 'changes_requested' && !(p.last_commit_at && new Date(p.last_commit_at) > new Date(p.last_review_at))) return 'waiting_for_author';
  return 'waiting_for_review';
}

export async function staleHoursFor(db, workspaceId) {
  const p = await db('reminder_policies').where({ workspace_id: workspaceId, type: 'stale_pr' }).first('threshold_hours');
  return p?.threshold_hours || DEFAULT_STALE_HOURS;
}

const serialize = (p, staleHours, now = Date.now()) => ({
  id: p.id,
  repository: { id: p.repository_id, fullName: p.full_name },
  number: p.number,
  title: p.title,
  author: p.author_login,
  state: p.state,
  draft: p.draft,
  merged: p.merged,
  baseBranch: p.base_ref,
  headBranch: p.head_ref,
  htmlUrl: p.html_url,
  reviewState: p.review_state,
  requestedReviewers: p.requested_reviewers,
  requestedTeams: p.requested_teams,
  status: derivePrStatus(p),
  stale: p.state === 'open' && now - new Date(p.last_activity_at).getTime() > staleHours * 3_600_000,
  ageHours: Math.round((now - new Date(p.gh_created_at).getTime()) / 3_600_000),
  createdAt: p.gh_created_at,
  lastActivityAt: p.last_activity_at,
  lastReviewAt: p.last_review_at,
  mergedAt: p.merged_at,
  syncedAt: p.synced_at,
});

/** /api/v1/workspaces/:workspaceId/pull-requests */
export function pullRequestRoutes(deps) {
  const { db } = deps;
  const router = express.Router({ mergeParams: true });
  const member = requireWorkspace(deps, 'member');

  router.get(
    '/',
    member,
    validate({
      query: paginationQuery.extend({
        status: z.enum(['open', 'waiting_for_review', 'waiting_for_author', 'approved', 'stale', 'draft', 'merged', 'closed', 'all']).default('open'),
        repositoryId: z.uuid().optional(),
        author: z.string().trim().max(100).optional(),
      }),
    }),
    async (req, res) => {
      const { status, repositoryId, author } = req.validated.query;
      const staleHours = await staleHoursFor(db, req.workspace.id);
      const q = db('pull_requests as p')
        .join('repositories as r', 'r.id', 'p.repository_id')
        .where('p.workspace_id', req.workspace.id)
        .whereNull('r.removed_at')
        .modify((qb) => {
          if (repositoryId) qb.where('p.repository_id', repositoryId);
          if (author) qb.whereRaw('lower(p.author_login) = lower(?)', [author]);
          const open = () => qb.where('p.state', 'open');
          switch (status) {
            case 'open':
              open();
              break;
            case 'waiting_for_review':
              open().whereRaw(PR_STATUS_SQL.waitingForReview);
              break;
            case 'waiting_for_author':
              open().whereRaw(PR_STATUS_SQL.waitingForAuthor);
              break;
            case 'approved':
              open().whereRaw(PR_STATUS_SQL.approved);
              break;
            case 'stale':
              open().where('p.draft', false).where('p.last_activity_at', '<', new Date(Date.now() - staleHours * 3_600_000));
              break;
            case 'draft':
              open().where('p.draft', true);
              break;
            case 'merged':
              qb.where('p.merged', true);
              break;
            case 'closed':
              qb.where('p.state', 'closed').where('p.merged', false);
              break;
            default:
          }
        })
        .orderBy(status === 'merged' ? 'p.merged_at' : 'p.last_activity_at', status === 'stale' ? 'asc' : 'desc')
        .select('p.*', 'r.full_name');
      const { rows, meta } = await paginate(q, req.validated.query);
      const now = Date.now();
      ok(res, rows.map((p) => serialize(p, staleHours, now)), { ...meta, staleHours });
    },
  );

  router.get('/summary', member, async (req, res) => {
    ok(res, await pullRequestSummary(db, req.workspace.id));
  });

  router.post('/:pullRequestId/refresh', member, validate({ params: z.object({ pullRequestId: z.uuid() }).loose() }), async (req, res) => {
    const pr = await db('pull_requests').where({ id: req.validated.params.pullRequestId, workspace_id: req.workspace.id }).first('id');
    if (!pr) throw notFound('Pull request not found');
    const fresh = await refreshPullRequestFromGitHub(deps, pr.id);
    if (!fresh) throw notFound('Pull request repository is not connected');
    const row = await db('pull_requests as p').join('repositories as r', 'r.id', 'p.repository_id').where('p.id', pr.id).first('p.*', 'r.full_name');
    ok(res, serialize(row, await staleHoursFor(db, req.workspace.id)));
  });

  return router;
}

export async function pullRequestSummary(db, workspaceId) {
  const staleHours = await staleHoursFor(db, workspaceId);
  const row = await db('pull_requests as p')
    .join('repositories as r', 'r.id', 'p.repository_id')
    .where({ 'p.workspace_id': workspaceId, 'p.state': 'open', 'r.monitoring_enabled': true })
    .whereNull('r.removed_at')
    .first(
      db.raw('count(*)::int as open'),
      db.raw(`count(*) filter (where ${PR_STATUS_SQL.waitingForReview})::int as waiting_for_review`),
      db.raw(`count(*) filter (where ${PR_STATUS_SQL.waitingForAuthor})::int as waiting_for_author`),
      db.raw('count(*) filter (where p.draft)::int as draft'),
      db.raw('count(*) filter (where p.draft = false and p.last_activity_at < ?)::int as stale', [new Date(Date.now() - staleHours * 3_600_000)]),
    );
  return {
    open: row.open,
    waitingForReview: row.waiting_for_review,
    waitingForAuthor: row.waiting_for_author,
    draft: row.draft,
    stale: row.stale,
    staleHours,
  };
}
