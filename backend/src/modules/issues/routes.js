import express from 'express';
import { z } from 'zod';
import { validate, paginationQuery } from '../../shared/validate.js';
import { ok, paginate } from '../../shared/http.js';
import { requireWorkspace } from '../../middleware/workspaceAccess.js';

const serialize = (i) => ({
  id: i.id,
  repository: { id: i.repository_id, fullName: i.full_name },
  number: i.number,
  title: i.title,
  author: i.author_login,
  state: i.state,
  stateReason: i.state_reason,
  assignees: i.assignees,
  labels: i.labels,
  htmlUrl: i.html_url,
  comments: i.comments_count,
  createdAt: i.gh_created_at,
  updatedAt: i.gh_updated_at,
  closedAt: i.closed_at,
  lastActivityAt: i.last_activity_at,
});

/** /api/v1/workspaces/:workspaceId/issues */
export function issueRoutes(deps) {
  const { db } = deps;
  const router = express.Router({ mergeParams: true });
  const member = requireWorkspace(deps, 'member');

  router.get(
    '/',
    member,
    validate({
      query: paginationQuery.extend({
        state: z.enum(['open', 'closed', 'all']).default('open'),
        unassigned: z.enum(['true', 'false']).optional(),
        label: z.string().trim().max(100).optional(),
        assignee: z.string().trim().max(100).optional(),
        repositoryId: z.uuid().optional(),
      }),
    }),
    async (req, res) => {
      const { state, unassigned, label, assignee, repositoryId } = req.validated.query;
      const q = db('issues as i')
        .join('repositories as r', 'r.id', 'i.repository_id')
        .where('i.workspace_id', req.workspace.id)
        .whereNull('r.removed_at')
        .modify((qb) => {
          if (state !== 'all') qb.where('i.state', state);
          if (unassigned === 'true') qb.whereRaw("i.assignees = '[]'::jsonb");
          if (unassigned === 'false') qb.whereRaw("i.assignees <> '[]'::jsonb");
          if (label) qb.whereRaw('i.labels \\? ?', [label]);
          if (assignee) qb.whereRaw('i.assignees \\? ?', [assignee]);
          if (repositoryId) qb.where('i.repository_id', repositoryId);
        })
        .orderBy('i.last_activity_at', 'desc')
        .select('i.*', 'r.full_name');
      const { rows, meta } = await paginate(q, req.validated.query);
      ok(res, rows.map(serialize), meta);
    },
  );

  router.get('/summary', member, async (req, res) => {
    ok(res, await issueSummary(db, req.workspace.id));
  });

  return router;
}

export async function issueSummary(db, workspaceId) {
  const row = await db('issues as i')
    .join('repositories as r', 'r.id', 'i.repository_id')
    .where({ 'i.workspace_id': workspaceId, 'i.state': 'open', 'r.monitoring_enabled': true })
    .whereNull('r.removed_at')
    .first(db.raw('count(*)::int as open'), db.raw("count(*) filter (where i.assignees = '[]'::jsonb)::int as unassigned"));
  return { open: row.open, unassigned: row.unassigned };
}
