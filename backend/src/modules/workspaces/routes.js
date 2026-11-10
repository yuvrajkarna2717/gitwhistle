import express from 'express';
import { z } from 'zod';
import { validate, paginationQuery } from '../../shared/validate.js';
import { ok, created, noContent, paginate } from '../../shared/http.js';
import { requireAuth } from '../../middleware/session.js';
import { requireWorkspace, assertRole, ROLE_RANK } from '../../middleware/workspaceAccess.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { randomToken, sha256 } from '../../shared/crypto.js';
import { audit } from '../../shared/audit.js';
import { DEFAULT_REMINDER_POLICIES } from '../reminders/policies.js';

const INVITE_TTL_DAYS = 7;

export const isValidTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

function slugify(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'workspace'}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'x'}`;
}

export function serializeWorkspace(w, role) {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    timezone: w.timezone,
    fallbackRoutingEnabled: w.fallback_routing_enabled,
    defaultChannelId: w.default_channel_id,
    digestEnabled: w.digest_enabled,
    digestHour: w.digest_hour,
    digestChannelId: w.digest_channel_id,
    createdAt: w.created_at,
    ...(role ? { role } : {}),
  };
}

async function assertChannelInWorkspace(db, workspaceId, channelId) {
  if (!channelId) return;
  const ch = await db('notification_channels').where({ id: channelId, workspace_id: workspaceId }).first('id');
  if (!ch) throw badRequest('Channel does not belong to this workspace');
}

async function ownerCount(db, workspaceId) {
  const row = await db('workspace_members').where({ workspace_id: workspaceId, role: 'owner' }).count({ c: '*' }).first();
  return Number(row.c);
}

const nameSchema = z.string().trim().min(2).max(100);

export function workspaceRoutes(deps) {
  const { db, config } = deps;
  const router = express.Router();
  const member = requireWorkspace(deps, 'member');
  const admin = requireWorkspace(deps, 'admin');
  const owner = requireWorkspace(deps, 'owner');

  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const rows = await db('workspace_members as m')
      .join('workspaces as w', 'w.id', 'm.workspace_id')
      .where('m.user_id', req.user.id)
      .orderBy('w.name')
      .select('w.*', 'm.role');
    ok(res, rows.map((r) => serializeWorkspace(r, r.role)));
  });

  router.post('/', validate({ body: z.object({ name: nameSchema, timezone: z.string().max(64).optional() }) }), async (req, res) => {
    const { name, timezone = 'UTC' } = req.validated.body;
    if (!isValidTimeZone(timezone)) throw badRequest('Unknown timezone');
    const workspace = await db.transaction(async (trx) => {
      const [w] = await trx('workspaces')
        .insert({ name, slug: slugify(name), timezone, created_by: req.user.id })
        .returning('*');
      await trx('workspace_members').insert({ workspace_id: w.id, user_id: req.user.id, role: 'owner' });
      await trx('reminder_policies').insert(DEFAULT_REMINDER_POLICIES.map((p) => ({ ...p, workspace_id: w.id })));
      return w;
    });
    await audit(db, req, { workspaceId: workspace.id, action: 'workspace.created', targetType: 'workspace', targetId: workspace.id });
    created(res, serializeWorkspace(workspace, 'owner'));
  });

  router.get('/:workspaceId', member, (req, res) => ok(res, serializeWorkspace(req.workspace, req.membership.role)));

  router.patch(
    '/:workspaceId',
    admin,
    validate({
      body: z
        .object({
          name: nameSchema.optional(),
          timezone: z.string().max(64).optional(),
          fallbackRoutingEnabled: z.boolean().optional(),
          defaultChannelId: z.uuid().nullable().optional(),
          digestEnabled: z.boolean().optional(),
          digestHour: z.number().int().min(0).max(23).optional(),
          digestChannelId: z.uuid().nullable().optional(),
        })
        .strict(),
    }),
    async (req, res) => {
      const b = req.validated.body;
      if (b.timezone && !isValidTimeZone(b.timezone)) throw badRequest('Unknown timezone');
      await assertChannelInWorkspace(db, req.workspace.id, b.defaultChannelId);
      await assertChannelInWorkspace(db, req.workspace.id, b.digestChannelId);
      const patch = {
        name: b.name,
        timezone: b.timezone,
        fallback_routing_enabled: b.fallbackRoutingEnabled,
        default_channel_id: b.defaultChannelId,
        digest_enabled: b.digestEnabled,
        digest_hour: b.digestHour,
        digest_channel_id: b.digestChannelId,
      };
      Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
      if (!Object.keys(patch).length) return ok(res, serializeWorkspace(req.workspace, req.membership.role));
      const [w] = await db('workspaces')
        .where({ id: req.workspace.id })
        .update({ ...patch, updated_at: db.fn.now() })
        .returning('*');
      await audit(db, req, { action: 'workspace.updated', targetType: 'workspace', targetId: w.id, metadata: { fields: Object.keys(patch) } });
      ok(res, serializeWorkspace(w, req.membership.role));
    },
  );

  router.delete('/:workspaceId', owner, async (req, res) => {
    await db('workspaces').where({ id: req.workspace.id }).del();
    noContent(res);
  });

  // ---- Members ----
  router.get('/:workspaceId/members', member, async (req, res) => {
    const rows = await db('workspace_members as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where('m.workspace_id', req.workspace.id)
      .orderBy([{ column: 'm.role', order: 'desc' }, 'u.login'])
      .select('u.id', 'u.login', 'u.name', 'u.avatar_url', 'm.role', 'm.created_at');
    ok(
      res,
      rows.map((r) => ({ userId: r.id, login: r.login, name: r.name, avatarUrl: r.avatar_url, role: r.role, joinedAt: r.created_at })),
    );
  });

  router.patch(
    '/:workspaceId/members/:userId',
    owner,
    validate({ params: z.object({ userId: z.uuid() }).loose(), body: z.object({ role: z.enum(['owner', 'admin', 'member']) }) }),
    async (req, res) => {
      const { userId } = req.validated.params;
      const { role } = req.validated.body;
      const target = await db('workspace_members').where({ workspace_id: req.workspace.id, user_id: userId }).first();
      if (!target) throw notFound('Member not found');
      if (target.role === 'owner' && role !== 'owner' && (await ownerCount(db, req.workspace.id)) <= 1) {
        throw conflict('A workspace must keep at least one owner');
      }
      await db('workspace_members')
        .where({ workspace_id: req.workspace.id, user_id: userId })
        .update({ role, updated_at: db.fn.now() });
      await audit(db, req, { action: 'member.role_changed', targetType: 'user', targetId: userId, metadata: { from: target.role, to: role } });
      ok(res, { userId, role });
    },
  );

  router.delete('/:workspaceId/members/:userId', member, validate({ params: z.object({ userId: z.uuid() }).loose() }), async (req, res) => {
    const { userId } = req.validated.params;
    const isSelf = userId === req.user.id;
    const target = await db('workspace_members').where({ workspace_id: req.workspace.id, user_id: userId }).first();
    if (!target) throw notFound('Member not found');
    if (!isSelf) {
      assertRole(req, 'admin');
      // Admins may remove members; only owners may remove admins or owners.
      if (ROLE_RANK[target.role] >= ROLE_RANK.admin && req.membership.role !== 'owner') throw forbidden('Only owners can remove admins');
    }
    if (target.role === 'owner' && (await ownerCount(db, req.workspace.id)) <= 1) {
      throw conflict('A workspace must keep at least one owner');
    }
    await db('workspace_members').where({ workspace_id: req.workspace.id, user_id: userId }).del();
    await audit(db, req, { action: isSelf ? 'member.left' : 'member.removed', targetType: 'user', targetId: userId });
    noContent(res);
  });

  // ---- Invitations ----
  router.get('/:workspaceId/invitations', admin, async (req, res) => {
    const rows = await db('workspace_invitations')
      .where({ workspace_id: req.workspace.id })
      .whereNull('accepted_at')
      .whereNull('revoked_at')
      .where('expires_at', '>', db.fn.now())
      .orderBy('created_at', 'desc');
    ok(res, rows.map((r) => ({ id: r.id, role: r.role, githubLogin: r.github_login, expiresAt: r.expires_at, createdAt: r.created_at })));
  });

  router.post(
    '/:workspaceId/invitations',
    admin,
    validate({
      body: z.object({
        role: z.enum(['admin', 'member']).default('member'),
        githubLogin: z.string().trim().regex(/^[A-Za-z0-9-]{1,39}$/).optional(),
      }),
    }),
    async (req, res) => {
      const token = randomToken(32);
      const [inv] = await db('workspace_invitations')
        .insert({
          workspace_id: req.workspace.id,
          token_hash: sha256(token),
          role: req.validated.body.role,
          github_login: req.validated.body.githubLogin?.toLowerCase() ?? null,
          created_by: req.user.id,
          expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000),
        })
        .returning('*');
      await audit(db, req, { action: 'invitation.created', targetType: 'invitation', targetId: inv.id, metadata: { role: inv.role } });
      // The raw token is shown exactly once; only its hash is stored.
      created(res, { id: inv.id, role: inv.role, githubLogin: inv.github_login, expiresAt: inv.expires_at, url: `${config.appUrl}/invite/${token}` });
    },
  );

  router.delete('/:workspaceId/invitations/:invitationId', admin, validate({ params: z.object({ invitationId: z.uuid() }).loose() }), async (req, res) => {
    const n = await db('workspace_invitations')
      .where({ id: req.validated.params.invitationId, workspace_id: req.workspace.id })
      .whereNull('accepted_at')
      .update({ revoked_at: db.fn.now() });
    if (!n) throw notFound('Invitation not found');
    await audit(db, req, { action: 'invitation.revoked', targetType: 'invitation', targetId: req.validated.params.invitationId });
    noContent(res);
  });

  router.get('/:workspaceId/audit-logs', admin, validate({ query: paginationQuery }), async (req, res) => {
    const q = db('audit_logs as a')
      .leftJoin('users as u', 'u.id', 'a.actor_user_id')
      .where('a.workspace_id', req.workspace.id)
      .orderBy('a.created_at', 'desc')
      .select('a.id', 'a.action', 'a.target_type', 'a.target_id', 'a.metadata', 'a.created_at', 'u.login as actor_login');
    const { rows, meta } = await paginate(q, req.validated.query);
    ok(
      res,
      rows.map((r) => ({ id: r.id, action: r.action, targetType: r.target_type, targetId: r.target_id, metadata: r.metadata, actor: r.actor_login, createdAt: r.created_at })),
      meta,
    );
  });

  return router;
}

/** Routes for invitees, who are not yet members. */
export function invitationAcceptRoutes(deps) {
  const { db } = deps;
  const router = express.Router();
  router.use(requireAuth);
  const tokenSchema = z.object({ token: z.string().min(20).max(200) });

  async function findInvitation(token) {
    const inv = await db('workspace_invitations as i')
      .join('workspaces as w', 'w.id', 'i.workspace_id')
      .where('i.token_hash', sha256(token))
      .first('i.*', 'w.name as workspace_name');
    if (!inv || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      throw notFound('Invitation is invalid or has expired');
    }
    return inv;
  }

  router.post('/preview', validate({ body: tokenSchema }), async (req, res) => {
    const inv = await findInvitation(req.validated.body.token);
    ok(res, { workspaceName: inv.workspace_name, role: inv.role, githubLogin: inv.github_login });
  });

  router.post('/accept', validate({ body: tokenSchema }), async (req, res) => {
    const inv = await findInvitation(req.validated.body.token);
    if (inv.github_login && inv.github_login !== req.user.login.toLowerCase()) {
      throw forbidden('This invitation was issued to a different GitHub account');
    }
    await db.transaction(async (trx) => {
      const claimed = await trx('workspace_invitations')
        .where({ id: inv.id })
        .whereNull('accepted_at')
        .update({ accepted_at: trx.fn.now(), accepted_by: req.user.id });
      if (!claimed) throw notFound('Invitation is invalid or has expired');
      await trx('workspace_members')
        .insert({ workspace_id: inv.workspace_id, user_id: req.user.id, role: inv.role })
        .onConflict(['workspace_id', 'user_id'])
        .ignore();
    });
    await audit(db, req, { workspaceId: inv.workspace_id, action: 'invitation.accepted', targetType: 'invitation', targetId: inv.id });
    ok(res, { workspaceId: inv.workspace_id });
  });

  return router;
}
