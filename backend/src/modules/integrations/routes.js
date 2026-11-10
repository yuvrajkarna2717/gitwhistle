import express from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { ok, noContent } from '../../shared/http.js';
import { requireWorkspace } from '../../middleware/workspaceAccess.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { createOAuthState, consumeOAuthState } from '../auth/oauthState.js';
import { decryptJson, encryptJson } from '../../shared/crypto.js';
import { logger, errSummary } from '../../shared/logger.js';
import { REQUIRED_PERMISSIONS, REQUIRED_EVENT_SUBSCRIPTIONS } from '../github/adapter.js';
import { SLACK_BOT_SCOPES } from '../slack/client.js';

export function serializeIntegration(i) {
  const c = i.config || {};
  const base = {
    id: i.id,
    provider: i.provider,
    kind: i.kind,
    status: i.status,
    displayName: i.display_name,
    accountType: i.account_type,
    connectedAt: i.connected_at,
    disconnectedAt: i.disconnected_at,
    lastError: i.last_error,
  };
  if (i.provider === 'github') {
    return {
      ...base,
      details: {
        installationId: i.external_id,
        accountLogin: c.accountLogin,
        repositorySelection: c.repositorySelection,
        missingPermissions: c.missingPermissions || [],
        missingEvents: c.missingEvents || [],
        htmlUrl: c.htmlUrl,
      },
    };
  }
  if (i.provider === 'slack') {
    return { ...base, details: { teamId: i.external_id, teamName: c.teamName, botUserId: c.botUserId, scopes: c.scopes || [] } };
  }
  return base;
}

/** Workspace-scoped integration management: /api/v1/workspaces/:workspaceId/integrations */
export function integrationRoutes(deps) {
  const { db, config, github, slack, queues } = deps;
  const router = express.Router({ mergeParams: true });
  const member = requireWorkspace(deps, 'member');
  const admin = requireWorkspace(deps, 'admin');

  router.get('/', member, async (req, res) => {
    const rows = await db('integrations').where({ workspace_id: req.workspace.id }).orderBy('created_at');
    ok(res, {
      integrations: rows.map(serializeIntegration),
      available: { github: config.github.enabled, slack: config.slack.enabled },
      requirements: { github: { permissions: REQUIRED_PERMISSIONS, events: REQUIRED_EVENT_SUBSCRIPTIONS }, slack: { scopes: SLACK_BOT_SCOPES } },
    });
  });

  // ---- GitHub ----
  router.get('/github/install', admin, async (req, res) => {
    const state = await createOAuthState(deps, res, {
      purpose: 'github_install',
      sessionId: req.session.id,
      userId: req.user.id,
      workspaceId: req.workspace.id,
    });
    res.redirect(302, github.installUrl({ state }));
  });

  router.post('/:integrationId/sync', admin, validate({ params: z.object({ integrationId: z.uuid() }).loose() }), async (req, res) => {
    const integration = await db('integrations').where({ id: req.validated.params.integrationId, workspace_id: req.workspace.id }).first();
    if (!integration) throw notFound('Integration not found');
    if (integration.provider !== 'github') throw badRequest('Only GitHub integrations can be synchronised');
    if (integration.status !== 'active') throw badRequest(`Integration is ${integration.status}`);
    await queues.enqueueTask('sync-installation', { integrationId: integration.id });
    ok(res, { queued: true });
  });

  router.delete('/:integrationId', admin, validate({ params: z.object({ integrationId: z.uuid() }).loose() }), async (req, res) => {
    const integration = await db('integrations').where({ id: req.validated.params.integrationId, workspace_id: req.workspace.id }).first();
    if (!integration) throw notFound('Integration not found');
    if (integration.provider === 'slack' && integration.credentials_encrypted) {
      try {
        const creds = decryptJson(integration.credentials_encrypted, config.encryptionKey);
        if (creds?.botToken) await slack.revoke(creds.botToken);
      } catch (err) {
        logger.warn({ err: errSummary(err) }, 'Slack token revoke failed during disconnect; continuing');
      }
    }
    await db.transaction(async (trx) => {
      await trx('integrations')
        .where({ id: integration.id })
        .update({ status: 'disconnected', credentials_encrypted: null, disconnected_at: trx.fn.now(), updated_at: trx.fn.now() });
      if (integration.provider === 'slack') {
        await trx('notification_channels').where({ integration_id: integration.id }).update({ enabled: false, updated_at: trx.fn.now() });
        await trx('notification_deliveries')
          .whereIn('status', ['pending', 'failed'])
          .whereIn('channel_id', trx('notification_channels').where({ integration_id: integration.id }).select('id'))
          .update({ status: 'skipped', last_error: 'Integration disconnected' });
      }
    });
    if (integration.provider === 'github') github.forgetInstallation?.(integration.external_id);
    await audit(db, req, { action: `integration.${integration.provider}.disconnected`, targetType: 'integration', targetId: integration.id });
    noContent(res);
  });

  // ---- Slack ----
  router.get('/slack/connect', admin, async (req, res) => {
    const state = await createOAuthState(deps, res, {
      purpose: 'slack_install',
      sessionId: req.session.id,
      userId: req.user.id,
      workspaceId: req.workspace.id,
    });
    res.redirect(302, slack.authorizeUrl({ state, redirectUri: `${config.apiUrl}/api/v1/integrations/slack/callback` }));
  });

  router.get('/slack/channels', admin, async (req, res) => {
    const integration = await db('integrations').where({ workspace_id: req.workspace.id, provider: 'slack', status: 'active' }).first();
    if (!integration) throw badRequest('Connect Slack first');
    const creds = decryptJson(integration.credentials_encrypted, config.encryptionKey);
    const available = await slack.listChannels(creds.botToken);
    const configured = await db('notification_channels').where({ integration_id: integration.id }).select('external_id', 'id', 'enabled');
    const byExternal = new Map(configured.map((c) => [c.external_id, c]));
    ok(
      res,
      available
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({ externalId: c.id, name: c.name, isPrivate: c.isPrivate, botIsMember: c.isMember, channelId: byExternal.get(c.id)?.id ?? null, enabled: byExternal.get(c.id)?.enabled ?? false })),
    );
  });

  return router;
}

/** Non-workspace-scoped callbacks: /api/v1/integrations/... */
export function integrationCallbackRoutes(deps) {
  const { db, config, github, slack } = deps;
  const router = express.Router();
  const toApp = (res, path, params = {}) => {
    const u = new URL(path, config.appUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    res.redirect(303, u.toString());
  };
  // These are browser navigations coming back from GitHub/Slack: redirect instead of returning JSON 401.
  const requireAuth = (req, res, next) => (req.user ? next() : toApp(res, '/login', { error: 'session_expired' }));

  /**
   * GitHub App "Setup URL". GitHub passes installation_id, which is attacker-controllable, so
   * ownership is verified by a second, user-authorized round trip (GET /user/installations).
   */
  router.get('/github/setup', requireAuth, async (req, res) => {
    let row;
    try {
      row = await consumeOAuthState(deps, req, res, { state: req.query.state, purposes: ['github_install'] });
    } catch {
      return toApp(res, '/', { error: 'invalid_state' });
    }
    const back = `/w/${row.workspace_id}/integrations`;
    if (req.query.setup_action === 'request') return toApp(res, back, { github: 'requested' });
    const installationId = String(req.query.installation_id || '');
    if (!/^\d{1,20}$/.test(installationId)) return toApp(res, back, { error: 'missing_installation' });

    const verifyState = await createOAuthState(deps, res, {
      purpose: 'github_install_verify',
      sessionId: req.session.id,
      userId: req.user.id,
      workspaceId: row.workspace_id,
      data: { installationId },
    });
    res.redirect(302, github.authorizeUrl({ state: verifyState, redirectUri: `${config.apiUrl}/api/v1/auth/github/callback` }));
  });

  router.get('/slack/callback', requireAuth, async (req, res) => {
    let row;
    try {
      row = await consumeOAuthState(deps, req, res, { state: req.query.state, purposes: ['slack_install'] });
    } catch {
      return toApp(res, '/', { error: 'invalid_state' });
    }
    const back = `/w/${row.workspace_id}/integrations`;
    if (req.query.error) return toApp(res, back, { error: req.query.error === 'access_denied' ? 'slack_access_denied' : 'slack_error' });
    if (typeof req.query.code !== 'string') return toApp(res, back, { error: 'missing_code' });

    try {
      const membership = await db('workspace_members').where({ workspace_id: row.workspace_id, user_id: req.user.id }).first('role');
      if (!membership || membership.role === 'member') return toApp(res, back, { error: 'forbidden' });

      const result = await slack.exchangeCode({ code: req.query.code, redirectUri: `${config.apiUrl}/api/v1/integrations/slack/callback` });
      const existing = await db('integrations').where({ provider: 'slack', external_id: result.team.id }).first();
      if (existing && existing.workspace_id !== row.workspace_id && existing.status === 'active') {
        return toApp(res, back, { error: 'slack_workspace_claimed' });
      }
      const values = {
        workspace_id: row.workspace_id,
        provider: 'slack',
        kind: 'destination',
        external_id: result.team.id,
        status: 'active',
        display_name: result.team.name,
        account_type: result.enterprise ? 'enterprise' : 'workspace',
        config: { teamName: result.team.name, botUserId: result.botUserId, appId: result.appId, scopes: result.scopes, enterpriseId: result.enterprise?.id ?? null },
        credentials_encrypted: encryptJson({ botToken: result.botToken }, config.encryptionKey),
        connected_by: req.user.id,
        connected_at: db.fn.now(),
        disconnected_at: null,
        last_error: null,
        updated_at: db.fn.now(),
      };
      const integration = await db.transaction(async (trx) => {
        if (existing && existing.workspace_id !== row.workspace_id) {
          await trx('notification_channels').where({ integration_id: existing.id }).del();
        }
        const [saved] = existing
          ? await trx('integrations').where({ id: existing.id }).update(values).returning('*')
          : await trx('integrations').insert(values).returning('*');
        return saved;
      });
      await audit(db, req, { workspaceId: row.workspace_id, action: 'integration.slack.connected', targetType: 'integration', targetId: integration.id, metadata: { team: result.team.name } });
      return toApp(res, back, { slack: 'connected' });
    } catch (err) {
      logger.warn({ err: errSummary(err) }, 'Slack OAuth callback failed');
      return toApp(res, back, { error: 'slack_oauth_failed' });
    }
  });

  return router;
}
