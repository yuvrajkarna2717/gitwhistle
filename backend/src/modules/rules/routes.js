import express from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { ok, created, noContent } from '../../shared/http.js';
import { requireWorkspace } from '../../middleware/workspaceAccess.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { ruleSchema, ruleUpdateSchema, RULE_FIELDS, OPERATORS } from './schema.js';
import { evaluateRules, ruleMatches } from './engine.js';
import { serializeRule, eventFromRow } from '../events/processor.js';
import { SUPPORTED_ACTIONS } from '../github/adapter.js';
import { activeChannels } from '../notifications/deliveries.js';

export const CANONICAL_EVENT_TYPES = [
  ...SUPPORTED_ACTIONS.pull_request.filter((a) => a !== 'closed').map((a) => `pull_request.${a}`),
  'pull_request.merged',
  'pull_request.closed',
  ...SUPPORTED_ACTIONS.pull_request_review.map((a) => `pull_request_review.${a}`),
  ...SUPPORTED_ACTIONS.issues.map((a) => `issues.${a}`),
  ...SUPPORTED_ACTIONS.issue_comment.map((a) => `issue_comment.${a}`),
  'push',
  'workflow_run.completed',
  'workflow_job.completed',
  ...SUPPORTED_ACTIONS.release.map((a) => `release.${a}`),
  'deployment.created',
  'deployment_status.created',
];

async function assertChannels(db, workspaceId, channelIds = []) {
  if (!channelIds.length) return;
  const found = await db('notification_channels').where({ workspace_id: workspaceId }).whereIn('id', channelIds).select('id');
  if (found.length !== new Set(channelIds).size) throw badRequest('One or more channels do not belong to this workspace');
}

const toRow = (b) => {
  const row = {
    name: b.name,
    description: b.description,
    enabled: b.enabled,
    priority: b.priority,
    match_mode: b.matchMode,
    conditions: b.conditions ? JSON.stringify(b.conditions) : undefined,
    actions: b.actions,
  };
  Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
  return row;
};

/** /api/v1/workspaces/:workspaceId/notification-rules */
export function ruleRoutes(deps) {
  const { db } = deps;
  const router = express.Router({ mergeParams: true });
  const member = requireWorkspace(deps, 'member');
  const admin = requireWorkspace(deps, 'admin');
  const ruleParams = z.object({ ruleId: z.uuid() }).loose();

  router.get('/meta', member, (_req, res) => ok(res, { fields: RULE_FIELDS, operators: OPERATORS, eventTypes: CANONICAL_EVENT_TYPES }));

  router.get('/', member, async (req, res) => {
    const rows = await db('notification_rules').where({ workspace_id: req.workspace.id }).orderBy([{ column: 'priority' }, { column: 'created_at' }]);
    ok(res, rows.map(serializeRule));
  });

  router.post('/', admin, validate({ body: ruleSchema }), async (req, res) => {
    await assertChannels(db, req.workspace.id, req.validated.body.actions.channelIds);
    const [row] = await db('notification_rules')
      .insert({ ...toRow(req.validated.body), workspace_id: req.workspace.id, created_by: req.user.id, updated_by: req.user.id })
      .returning('*');
    await audit(db, req, { action: 'rule.created', targetType: 'notification_rule', targetId: row.id, metadata: { name: row.name } });
    created(res, serializeRule(row));
  });

  router.patch('/:ruleId', admin, validate({ params: ruleParams, body: ruleUpdateSchema }), async (req, res) => {
    if (req.validated.body.actions) await assertChannels(db, req.workspace.id, req.validated.body.actions.channelIds);
    const [row] = await db('notification_rules')
      .where({ id: req.validated.params.ruleId, workspace_id: req.workspace.id })
      .update({ ...toRow(req.validated.body), updated_by: req.user.id, updated_at: db.fn.now() })
      .returning('*');
    if (!row) throw notFound('Rule not found');
    await audit(db, req, { action: 'rule.updated', targetType: 'notification_rule', targetId: row.id, metadata: { fields: Object.keys(req.validated.body) } });
    ok(res, serializeRule(row));
  });

  router.delete('/:ruleId', admin, validate({ params: ruleParams }), async (req, res) => {
    const n = await db('notification_rules').where({ id: req.validated.params.ruleId, workspace_id: req.workspace.id }).del();
    if (!n) throw notFound('Rule not found');
    await audit(db, req, { action: 'rule.deleted', targetType: 'notification_rule', targetId: req.validated.params.ruleId });
    noContent(res);
  });

  /**
   * Dry run. With `eventId`: full routing decision (all enabled rules + optional draft rule) for that event.
   * Without: which of the last 100 stored events the draft rule would have matched.
   */
  router.post(
    '/preview',
    member,
    validate({ body: z.object({ rule: ruleSchema.optional(), eventId: z.uuid().optional() }).refine((b) => b.rule || b.eventId, 'Provide a rule, an eventId, or both') }),
    async (req, res) => {
      const { rule, eventId } = req.validated.body;
      const draft = rule ? { ...rule, id: 'draft', createdAt: new Date().toISOString() } : null;

      if (eventId) {
        const row = await db('events as e')
          .leftJoin('repositories as r', 'r.id', 'e.repository_id')
          .where({ 'e.id': eventId, 'e.workspace_id': req.workspace.id })
          .first('e.*', 'r.full_name as repo_full_name', 'r.default_channel_id as repo_channel_id');
        if (!row) throw notFound('Event not found');
        const rules = (await db('notification_rules').where({ workspace_id: req.workspace.id })).map(serializeRule);
        const channels = await activeChannels(db, req.workspace.id);
        const result = evaluateRules(eventFromRow(row), draft ? [...rules, draft] : rules, {
          fallback: { enabled: req.workspace.fallback_routing_enabled, channelId: row.repo_channel_id || req.workspace.default_channel_id },
          activeChannelIds: new Set(channels.map((c) => c.id)),
        });
        const names = new Map(channels.map((c) => [c.id, c.name]));
        return ok(res, { ...result, channels: result.channels.map((c) => ({ ...c, channelName: names.get(c.channelId) })) });
      }

      const recent = await db('events as e')
        .leftJoin('repositories as r', 'r.id', 'e.repository_id')
        .where('e.workspace_id', req.workspace.id)
        .orderBy('e.occurred_at', 'desc')
        .limit(100)
        .select('e.*', 'r.full_name as repo_full_name');
      const matches = recent.map((r) => eventFromRow(r)).filter((e) => ruleMatches(e, draft));
      ok(res, { evaluated: recent.length, matched: matches.length, sample: matches.slice(0, 10).map((e) => ({ id: e.id, eventType: e.eventType, title: e.resource?.title, repository: e.repository?.fullName, occurredAt: e.occurredAt })) });
    },
  );

  return router;
}
