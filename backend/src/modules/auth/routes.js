import express from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { ok } from '../../shared/http.js';
import { requireAuth } from '../../middleware/session.js';
import { createOAuthState, consumeOAuthState } from './oauthState.js';
import { upsertGitHubUser, createSession, destroySession } from './sessions.js';
import { completeInstallationClaim } from '../github/installations.js';
import { logger, errSummary } from '../../shared/logger.js';
import { AppError } from '../../shared/errors.js';

/** Only allow same-app relative paths as post-login destinations (prevents open redirects). */
export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value.slice(0, 500);
}

export function authRoutes(deps) {
  const { db, config, github } = deps;
  const router = express.Router();
  const callbackUrl = `${config.apiUrl}/api/v1/auth/github/callback`;
  const redirectToApp = (res, path, params = {}) => {
    const u = new URL(path, config.appUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    res.redirect(303, u.toString());
  };

  router.get(
    '/github/login',
    validate({ query: z.object({ returnTo: z.string().max(500).optional() }) }),
    async (req, res) => {
      const state = await createOAuthState(deps, res, {
        purpose: 'login',
        data: { returnTo: safeReturnTo(req.validated.query.returnTo) },
      });
      res.redirect(302, github.authorizeUrl({ state, redirectUri: callbackUrl }));
    },
  );

  /**
   * One callback serves both login and installation-ownership verification, because GitHub Apps
   * have a single user-authorization callback URL.
   */
  router.get('/github/callback', async (req, res) => {
    const { code, state, error } = req.query;
    let stateRow;
    try {
      stateRow = await consumeOAuthState(deps, req, res, { state, purposes: ['login', 'github_install_verify'] });
    } catch (err) {
      return redirectToApp(res, '/login', { error: 'invalid_state' });
    }

    const failPath = stateRow.purpose === 'login' ? '/login' : `/w/${stateRow.workspace_id}/integrations`;
    if (error) return redirectToApp(res, failPath, { error: error === 'access_denied' ? 'access_denied' : 'oauth_error' });
    if (typeof code !== 'string' || code.length > 200) return redirectToApp(res, failPath, { error: 'missing_code' });

    try {
      const userToken = await github.exchangeCode({ code, redirectUri: callbackUrl });

      if (stateRow.purpose === 'login') {
        const ghUser = await github.getAuthenticatedUser(userToken);
        const user = await upsertGitHubUser(db, ghUser);
        if (req.session) await destroySession(deps, req, res); // rotate session on login
        await createSession(deps, req, res, user.id);
        return redirectToApp(res, stateRow.data.returnTo || '/');
      }

      // github_install_verify: the state is bound to the session that started the install.
      if (!req.user || req.user.id !== stateRow.user_id) return redirectToApp(res, '/login', { error: 'session_mismatch' });
      const ghUser = await github.getAuthenticatedUser(userToken);
      if (Number(ghUser.id) !== Number(req.user.githubId)) {
        return redirectToApp(res, failPath, { error: 'github_account_mismatch' });
      }
      const accessible = await github.listUserInstallationIds(userToken);
      await completeInstallationClaim(deps, req, {
        workspaceId: stateRow.workspace_id,
        installationId: stateRow.data.installationId,
        accessibleInstallationIds: accessible,
      });
      return redirectToApp(res, failPath, { github: 'connected' });
    } catch (err) {
      logger.warn({ err: errSummary(err), purpose: stateRow.purpose }, 'GitHub OAuth callback failed');
      const code = err instanceof AppError ? err.code : 'auth_failed';
      return redirectToApp(res, failPath, { error: code });
    }
  });

  router.get('/me', requireAuth, async (req, res) => {
    const workspaces = await db('workspace_members as m')
      .join('workspaces as w', 'w.id', 'm.workspace_id')
      .where('m.user_id', req.user.id)
      .orderBy('w.name')
      .select('w.id', 'w.name', 'w.slug', 'm.role');
    ok(res, { user: req.user, csrfToken: req.session.csrfToken, workspaces });
  });

  router.post('/logout', requireAuth, async (req, res) => {
    await destroySession(deps, req, res);
    ok(res, { loggedOut: true });
  });

  return router;
}
