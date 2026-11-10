import express from 'express';
import { z } from 'zod';
import { validate, paginationQuery } from '../../shared/validate.js';
import { ok, paginate } from '../../shared/http.js';
import { requireWorkspace } from '../../middleware/workspaceAccess.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { logger, errSummary } from '../../shared/logger.js';

const serialize = (r) => ({
  id: r.id,
  provider: r.provider,
  fullName: r.full_name,
  name: r.name,
  owner: r.owner_login,
  private: r.private,
  archived: r.archived,
  disabled: r.disabled,
  defaultBranch: r.default_branch,
  htmlUrl: r.html_url,
  monitoringEnabled: r.monitoring_enabled,
  defaultChannelId: r.default_channel_id,
  removed: Boolean(r.removed_at),
  syncedAt: r.synced_at,
  integration: { id: r.integration_id, displayName: r.integration_name, status: r.integration_status },
});

/** /api/v1/workspaces/:workspaceId/repositories */
export function repositoryRoutes(deps) {
  const { db, queues } = deps;
  const router = express.Router({ mergeParams: true });
  const member = requireWorkspace(deps, 'member');
  const admin = requireWorkspace(deps, 'admin');
  const repoParams = z.object({ repositoryId: z.uuid() }).loose();

  const base = (workspaceId) =>
    db('repositories as r')
      .join('integrations as i', 'i.id', 'r.integration_id')
      .where('r.workspace_id', workspaceId)
      .select('r.*', 'i.display_name as integration_name', 'i.status as integration_status');

  router.get(
    '/',
    member,
    validate({
      query: paginationQuery.extend({
        search: z.string().trim().max(100).optional(),
        monitored: z.enum(['true', 'false']).optional(),
        includeRemoved: z.enum(['true', 'false']).optional(),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
    }),
    async (req, res) => {
      const { search, monitored, includeRemoved } = req.validated.query;
      const q = base(req.workspace.id)
        .modify((qb) => {
          if (search) qb.whereILike('r.full_name', `%${search.replace(/[%_\\]/g, '\\$&')}%`);
          if (monitored) qb.where('r.monitoring_enabled', monitored === 'true');
          if (includeRemoved !== 'true') qb.whereNull('r.removed_at');
        })
        .orderBy('r.full_name');
      const { rows, meta } = await paginate(q, req.validated.query);
      ok(res, rows.map(serialize), meta);
    },
  );

  router.patch(
    '/:repositoryId',
    admin,
    validate({ params: repoParams, body: z.object({ monitoringEnabled: z.boolean().optional(), defaultChannelId: z.uuid().nullable().optional() }).strict() }),
    async (req, res) => {
      const { repositoryId } = req.validated.params;
      const { monitoringEnabled, defaultChannelId } = req.validated.body;
      const repo = await db('repositories').where({ id: repositoryId, workspace_id: req.workspace.id }).first();
      if (!repo) throw notFound('Repository not found');
      if (defaultChannelId) {
        const ch = await db('notification_channels').where({ id: defaultChannelId, workspace_id: req.workspace.id }).first('id');
        if (!ch) throw badRequest('Channel does not belong to this workspace');
      }
      const patch = { updated_at: db.fn.now() };
      if (monitoringEnabled !== undefined) patch.monitoring_enabled = monitoringEnabled;
      if (defaultChannelId !== undefined) patch.default_channel_id = defaultChannelId;
      await db('repositories').where({ id: repo.id }).update(patch);
      if (monitoringEnabled && !repo.monitoring_enabled) {
        await queues.enqueueTask('sync-repository', { repositoryId: repo.id }).catch((err) => logger.warn({ err: errSummary(err) }, 'Repository sync enqueue failed'));
      }
      await audit(db, req, { action: 'repository.updated', targetType: 'repository', targetId: repo.id, metadata: { fullName: repo.full_name, ...req.validated.body } });
      ok(res, serialize(await base(req.workspace.id).where('r.id', repo.id).first()));
    },
  );

  router.post('/:repositoryId/sync', admin, validate({ params: repoParams }), async (req, res) => {
    const repo = await db('repositories').where({ id: req.validated.params.repositoryId, workspace_id: req.workspace.id }).first('id');
    if (!repo) throw notFound('Repository not found');
    await queues.enqueueTask('sync-repository', { repositoryId: repo.id });
    ok(res, { queued: true });
  });

  return router;
}
