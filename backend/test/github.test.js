import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { buildApp, resetDb, testDb, createUser, createSession, createWorkspace, authed, sendWebhook, installationObject, repoObject, fakeGitHub } from './helpers.js';
import { createGitHubClient } from '../src/modules/github/client.js';
import { syncInstallation } from '../src/modules/github/installations.js';
import { processWebhookDelivery } from '../src/modules/events/processor.js';
import { loadConfig } from '../src/config/env.js';

const cookiesFrom = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);

async function processAll(deps) {
  for (const id of deps.queues.events.splice(0)) await processWebhookDelivery(deps, id, { throwOnRetry: false });
}

describe('GitHub App installation lifecycle', () => {
  beforeEach(resetDb);

  async function adminContext(opts) {
    const ctx = buildApp(opts);
    const user = await createUser({ login: 'alice', github_id: 1001 });
    const ws = await createWorkspace(user);
    const session = await createSession(user, ctx.deps.config);
    return { ...ctx, user, ws, session };
  }

  async function runInstallFlow(ctx, { installationId = '555' } = {}) {
    const { app, ws, session } = ctx;
    const start = await authed(app, session).get(`/api/v1/workspaces/${ws.id}/integrations/github/install`);
    expect(start.status).toBe(302);
    const installState = new URL(start.headers.location).searchParams.get('state');
    const jar = [session.cookie, ...cookiesFrom(start)];

    const setup = await request(app)
      .get(`/api/v1/integrations/github/setup?installation_id=${installationId}&setup_action=install&state=${installState}`)
      .set('Cookie', jar.join('; '));
    expect(setup.status).toBe(302);
    const verifyState = new URL(setup.headers.location).searchParams.get('state');
    jar.push(...cookiesFrom(setup));
    return request(app).get(`/api/v1/auth/github/callback?code=c0de&state=${verifyState}`).set('Cookie', jar.join('; '));
  }

  it('links an installation to the workspace only after verifying the user can access it', async () => {
    const ctx = await adminContext();
    const done = await runInstallFlow(ctx);
    expect(done.status).toBe(303);
    expect(done.headers.location).toContain(`/w/${ctx.ws.id}/integrations?github=connected`);
    const integ = await testDb()('integrations').where({ provider: 'github' }).first();
    expect(integ).toMatchObject({ workspace_id: ctx.ws.id, external_id: '555', status: 'active', display_name: 'acme' });
    expect(integ.config.missingPermissions).toEqual([]);
    expect(ctx.deps.queues.tasks).toContainEqual({ name: 'sync-installation', data: { integrationId: integ.id } });
    expect(ctx.deps.github.listUserInstallationIds).toHaveBeenCalledWith('gho_user_token');
  });

  it('refuses to link an installation the user cannot access (forged installation_id)', async () => {
    const ctx = await adminContext();
    const done = await runInstallFlow(ctx, { installationId: '999' });
    expect(done.headers.location).toContain('error=forbidden');
    expect(await testDb()('integrations').count({ n: '*' }).first()).toEqual({ n: 0 });
  });

  it('refuses to link an installation already owned by another workspace', async () => {
    const ctx = await adminContext();
    const other = await createWorkspace(await createUser());
    await testDb()('integrations').insert({ workspace_id: other.id, provider: 'github', kind: 'source', external_id: '555', status: 'active', config: {} });
    const done = await runInstallFlow(ctx);
    expect(done.headers.location).toContain('error=installation_claimed');
  });

  it('records permission gaps reported by GitHub', async () => {
    const github = fakeGitHub({ getInstallation: async (id) => installationObject(id, { permissions: { metadata: 'read', pull_requests: 'read' }, events: ['pull_request'] }) });
    const ctx = await adminContext({ github });
    await runInstallFlow(ctx);
    const integ = await testDb()('integrations').first();
    expect(integ.config.missingPermissions).toContain('actions:read');
    expect(integ.config.missingEvents).toContain('workflow_run');
  });

  it('synchronises every repository across pages and marks removed ones', async () => {
    const many = Array.from({ length: 250 }, (_, i) => repoObject(i + 1, `acme/repo-${i + 1}`, { archived: i === 0 }));
    const ctx = await adminContext({ github: fakeGitHub({ listInstallationRepositories: async () => many }) });
    const [integ] = await testDb()('integrations').insert({ workspace_id: ctx.ws.id, provider: 'github', kind: 'source', external_id: '555', status: 'active', config: {} }).returning('*');
    const r = await syncInstallation(ctx.deps, integ.id);
    expect(r).toEqual({ repositories: 250, added: 250 });
    expect(await testDb()('repositories').where({ workspace_id: ctx.ws.id }).count({ n: '*' }).first()).toEqual({ n: 250 });
    expect((await testDb()('repositories').where({ external_id: '1' }).first()).monitoring_enabled).toBe(false); // archived
    expect(ctx.deps.queues.tasks.filter((t) => t.name === 'sync-repository')).toHaveLength(249);

    ctx.deps.github.listInstallationRepositories = async () => many.slice(0, 200);
    await syncInstallation(ctx.deps, integ.id);
    expect(await testDb()('repositories').whereNotNull('removed_at').count({ n: '*' }).first()).toEqual({ n: 50 });
  });

  it('handles installation webhooks: created before claim, suspend, and deletion', async () => {
    const ctx = await adminContext();
    const created = await sendWebhook(ctx.app, ctx.deps.config, 'installation', { action: 'created', installation: installationObject(555), repositories: [{ id: 1, full_name: 'acme/api', name: 'api', private: true }], sender: { login: 'alice' } });
    expect(created.status).toBe(202);
    await processAll(ctx.deps);
    let integ = await testDb()('integrations').first();
    expect(integ).toMatchObject({ workspace_id: null, status: 'active' });
    expect(await testDb()('repositories').count({ n: '*' }).first()).toEqual({ n: 1 });

    // An event for an unclaimed installation is stored but not attributed to any tenant.
    await sendWebhook(ctx.app, ctx.deps.config, 'push', { ref: 'refs/heads/main', commits: [], repository: repoObject(1, 'acme/api'), installation: { id: 555 }, sender: { login: 'x' } });
    await processAll(ctx.deps);
    expect((await testDb()('webhook_deliveries').where({ event_name: 'push' }).first()).ignore_reason).toBe('installation not linked to a workspace');

    await runInstallFlow(ctx);
    integ = await testDb()('integrations').first();
    expect(integ.workspace_id).toBe(ctx.ws.id);
    expect((await testDb()('repositories').first()).workspace_id).toBe(ctx.ws.id);

    await sendWebhook(ctx.app, ctx.deps.config, 'installation', { action: 'suspend', installation: installationObject(555, { suspended_at: '2026-11-01T00:00:00Z' }), sender: { login: 'alice' } });
    await processAll(ctx.deps);
    expect((await testDb()('integrations').first()).status).toBe('suspended');

    await sendWebhook(ctx.app, ctx.deps.config, 'installation', { action: 'deleted', installation: installationObject(555), sender: { login: 'alice' } });
    await processAll(ctx.deps);
    expect((await testDb()('integrations').first()).status).toBe('deleted');
    expect((await testDb()('repositories').first()).removed_at).not.toBeNull();
    expect(ctx.deps.github.forgetInstallation).toHaveBeenCalledWith('555');
  });
});

describe('GitHub API client (against a local fake GitHub)', () => {
  const calls = [];
  let server;
  let baseUrl;
  afterAll(() => server?.close());

  it('mints one installation token, caches it, and paginates repositories', async () => {
    server = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url} ${req.headers.authorization?.split(' ')[0]}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/app/installations/555/access_tokens') {
        res.statusCode = 201;
        return res.end(JSON.stringify({ token: 'ghs_installation_token', expires_at: new Date(Date.now() + 3600_000).toISOString() }));
      }
      if (req.url.startsWith('/installation/repositories')) {
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page') || 1);
        const repos = Array.from({ length: page < 3 ? 100 : 7 }, (_, i) => ({ id: (page - 1) * 100 + i + 1, full_name: `acme/r${(page - 1) * 100 + i + 1}` }));
        if (page < 3) res.setHeader('Link', `<${baseUrl}/installation/repositories?per_page=100&page=${page + 1}>; rel="next"`);
        return res.end(JSON.stringify({ total_count: 207, repositories: repos }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const config = loadConfig({ ...process.env, GITHUB_API_URL: baseUrl });
    const client = createGitHubClient(config);
    const repos = await client.listInstallationRepositories('555');
    expect(repos).toHaveLength(207);
    await client.listInstallationRepositories('555');

    const tokenCalls = calls.filter((c) => c.includes('access_tokens'));
    expect(tokenCalls).toHaveLength(1); // cached for the second sync
    expect(tokenCalls[0]).toContain('bearer'); // app JWT used only to mint the token
    expect(calls.filter((c) => c.startsWith('GET /installation/repositories')).every((c) => c.endsWith('token'))).toBe(true);
  });
});
