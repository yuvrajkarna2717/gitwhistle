import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { logger } from '../../shared/logger.js';
import { metrics } from '../../shared/metrics.js';
import { serviceUnavailable } from '../../shared/errors.js';

const GitWhistleOctokit = Octokit.plugin(retry, throttling);
const MAX_CACHED_INSTALLATIONS = 500;

/**
 * Real GitHub client. All GitHub network access goes through this object so tests can
 * substitute a fake with the same shape.
 */
export function createGitHubClient(config) {
  const gh = config.github;

  function build(options = {}) {
    const octokit = new GitWhistleOctokit({
      baseUrl: gh.apiUrl,
      userAgent: 'GitWhistle',
      log: { debug: () => {}, info: () => {}, warn: (m) => logger.warn({ msg: m }, 'octokit'), error: (m) => logger.error({ msg: m }, 'octokit') },
      throttle: {
        onRateLimit: (retryAfter, opts, _o, retryCount) => {
          logger.warn({ retryAfter, url: opts.url }, 'GitHub primary rate limit hit');
          return retryCount < 2 && retryAfter < 120;
        },
        onSecondaryRateLimit: (retryAfter, opts, _o, retryCount) => {
          logger.warn({ retryAfter, url: opts.url }, 'GitHub secondary rate limit hit');
          return retryCount < 1 && retryAfter < 120;
        },
      },
      ...options,
    });
    octokit.hook.error('request', (error) => {
      metrics.githubApiErrors.inc({ status: String(error.status || 'network') });
      throw error;
    });
    return octokit;
  }

  function requireApp() {
    if (!gh.enabled) throw serviceUnavailable('GitHub App is not configured on this server');
  }

  let appOctokit;
  const installationClients = new Map();

  function app() {
    requireApp();
    if (!appOctokit) appOctokit = build({ authStrategy: createAppAuth, auth: { appId: gh.appId, privateKey: gh.privateKey } });
    return appOctokit;
  }

  /**
   * Octokit authenticated as an installation. @octokit/auth-app caches installation tokens and
   * mints a new one shortly before the 1-hour expiry, so callers never handle raw tokens.
   */
  function installation(installationId) {
    requireApp();
    const key = String(installationId);
    let client = installationClients.get(key);
    if (client) {
      installationClients.delete(key);
      installationClients.set(key, client); // LRU bump
      return client;
    }
    client = build({
      authStrategy: createAppAuth,
      auth: { appId: gh.appId, privateKey: gh.privateKey, installationId: Number(installationId) },
    });
    installationClients.set(key, client);
    if (installationClients.size > MAX_CACHED_INSTALLATIONS) {
      installationClients.delete(installationClients.keys().next().value);
    }
    return client;
  }

  return {
    authorizeUrl({ state, redirectUri }) {
      requireApp();
      const u = new URL(`${gh.webUrl}/login/oauth/authorize`);
      u.searchParams.set('client_id', gh.clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      u.searchParams.set('allow_signup', 'true');
      return u.toString();
    },

    installUrl({ state }) {
      requireApp();
      const u = new URL(`${gh.webUrl}/apps/${encodeURIComponent(gh.slug)}/installations/new`);
      u.searchParams.set('state', state);
      return u.toString();
    },

    /** Exchanges an OAuth code for a short-lived user access token. The token is never persisted. */
    async exchangeCode({ code, redirectUri }) {
      requireApp();
      const res = await fetch(`${gh.webUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code, redirect_uri: redirectUri }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.access_token) {
        const err = new Error(`GitHub OAuth token exchange failed: ${body.error || res.status}`);
        err.code = body.error || 'token_exchange_failed';
        throw err;
      }
      return body.access_token;
    },

    async getAuthenticatedUser(userToken) {
      const octokit = build({ auth: userToken });
      const { data } = await octokit.request('GET /user');
      let email = data.email || null;
      if (!email) {
        try {
          const { data: emails } = await octokit.request('GET /user/emails');
          email = emails.find((e) => e.primary && e.verified)?.email || null;
        } catch (err) {
          // Requires the optional "Email addresses" account permission; login works without it.
          logger.debug({ status: err.status }, 'Could not read user emails');
        }
      }
      return { id: data.id, login: data.login, name: data.name, email, avatarUrl: data.avatar_url };
    },

    /** IDs of installations of this App that the user can access (authoritative ownership check). */
    async listUserInstallationIds(userToken) {
      const octokit = build({ auth: userToken });
      const installations = await octokit.paginate('GET /user/installations', { per_page: 100 });
      return installations.map((i) => String(i.id));
    },

    async getInstallation(installationId) {
      const { data } = await app().request('GET /app/installations/{installation_id}', {
        installation_id: Number(installationId),
      });
      return data;
    },

    /** Every repository the installation can access, across all pages. */
    async listInstallationRepositories(installationId) {
      return installation(installationId).paginate('GET /installation/repositories', { per_page: 100 });
    },

    async getPullRequest(installationId, owner, repo, number) {
      const { data } = await installation(installationId).request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo,
        pull_number: number,
      });
      return data;
    },

    async listPullRequestReviews(installationId, owner, repo, number) {
      return installation(installationId).paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
    },

    async listOpenPullRequests(installationId, owner, repo) {
      return installation(installationId).paginate('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        state: 'open',
        per_page: 100,
      });
    },

    async listOpenIssues(installationId, owner, repo) {
      const items = await installation(installationId).paginate('GET /repos/{owner}/{repo}/issues', {
        owner,
        repo,
        state: 'open',
        per_page: 100,
      });
      return items.filter((i) => !i.pull_request); // the issues API also returns PRs
    },

    forgetInstallation(installationId) {
      installationClients.delete(String(installationId));
    },
  };
}
