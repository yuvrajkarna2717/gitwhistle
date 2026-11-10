import express from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { ok } from '../../shared/http.js';
import { requireWorkspace } from '../../middleware/workspaceAccess.js';
import { badRequest } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { REMINDER_TYPES, DEFAULT_REMINDER_POLICIES, serializePolicy } from './policies.js';

/** /api/v1/workspaces/:workspaceId/reminder-policies */
export function reminderRoutes(deps) {
  const { db } = deps;
  const router = express.Router({ mergeParams: true });
  const member = requireWorkspace(deps, 'member');
  const admin = requireWorkspace(deps, 'admin');

  router.get('/', member, async (req, res) => {
    const rows = await db('reminder_policies').where({ workspace_id: req.workspace.id });
    const byType = new Map(rows.map((r) => [r.type, r]));
    // Workspaces created before a policy type existed still get a sensible default.
    ok(
      res,
      REMINDER_TYPES.map((type) => serializePolicy(byType.get(type) || { ...DEFAULT_REMINDER_POLICIES.find((p) => p.type === type), id: null, channel_id: null })),
    );
  });

  router.put(
    '/:type',
    admin,
    validate({
      params: z.object({ type: z.enum(REMINDER_TYPES) }).loose(),
      body: z.object({
        enabled: z.boolean(),
        thresholdHours: z.number().int().min(1).max(2160),
        repeatHours: z.number().int().min(1).max(2160).nullable().default(null),
        channelId: z.uuid().nullable().default(null),
      }),
    }),
    async (req, res) => {
      const { type } = req.validated.params;
      const b = req.validated.body;
      if (b.channelId) {
        const ch = await db('notification_channels').where({ id: b.channelId, workspace_id: req.workspace.id }).first('id');
        if (!ch) throw badRequest('Channel does not belong to this workspace');
      }
      const [row] = await db('reminder_policies')
        .insert({ workspace_id: req.workspace.id, type, enabled: b.enabled, threshold_hours: b.thresholdHours, repeat_hours: b.repeatHours, channel_id: b.channelId })
        .onConflict(['workspace_id', 'type'])
        .merge(['enabled', 'threshold_hours', 'repeat_hours', 'channel_id', 'updated_at'])
        .returning('*');
      await audit(db, req, { action: 'reminder_policy.updated', targetType: 'reminder_policy', targetId: row.id, metadata: { type, ...b } });
      ok(res, serializePolicy(row));
    },
  );

  return router;
}
