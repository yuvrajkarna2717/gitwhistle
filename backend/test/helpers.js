import { vi } from 'vitest';
import knexFactory from 'knex';
import request from 'supertest';
import { loadConfig } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { createRegistry } from '../src/modules/integrations/registry.js';
import { randomToken, sha256, encryptJson } from '../src/shared/crypto.js';
import { signGitHubPayload } from '../src/modules/github/signature.js';
import { DEFAULT_REMINDER_POLICIES } from '../src/modules/reminders/policies.js';

let db;
export function testDb() {
  if (!db) db = knexFactory({ client: 'pg', connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 5 } });
  return db;
}

const TABLES = [
  'audit_logs',
  'daily_digests',
  'reminder_policies',
  'pull_request_reviews',
  'pull_requests',
  'issues',
  'notification_deliveries',
  'notification_rules',
  'events',
  'event_processing_attempts',
  'webhook_deliveries',
  'repositories',
  'notification_channels',
  'integrations',
  'oauth_states',
  'workspace_invitations',
  'workspace_members',
  'workspaces',
  'sessions',
  'users',
];

export async function resetDb() {
  await testDb().raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export function fakeQueues() {
  const q = {
    events: [],
    deliveries: [],
    tasks: [],
    fail: false,
    enqueueEvent: vi.fn(async (id) => {
      if (q.fail) throw new Error('redis down');
      q.events.push(id);
    }),
    enqueueDelivery: vi.fn(async (id) => {
      if (q.fail) throw new Error('redis down');
      q.deliveries.push(id);
    }),
    enqueueTask: vi.fn(async (name, data) => {
      if (q.fail) throw new Error('redis down');
      q.tasks.push({ name, data });
    }),
    ping: vi.fn(async () => 'PONG'),
    close: vi.fn(async () => {}),
    queues: {},
  };
  return q;
}

export function fakeGitHub(overrides = {}) {
  return {
    authorizeUrl: ({ state, redirectUri }) => `https://github.test/login/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    installUrl: ({ state }) => `https://github.test/apps/gitwhistle-test/installations/new?state=${state}`,
    exchangeCode: vi.fn(async () => 'gho_user_token'),
    getAuthenticatedUser: vi.fn(async () => ({ id: 1001, login: 'alice', name: 'Alice', email: 'alice@example.com', avatarUrl: null })),
    listUserInstallationIds: vi.fn(async () => ['555']),
    getInstallation: vi.fn(async (id) => installationObject(id)),
    listInstallationRepositories: vi.fn(async () => [repoObject(1, 'acme/api'), repoObject(2, 'acme/web')]),
    getPullRequest: vi.fn(),
    listPullRequestReviews: vi.fn(async () => []),
    listOpenPullRequests: vi.fn(async () => []),
    listOpenIssues: vi.fn(async () => []),
    forgetInstallation: vi.fn(),
    ...overrides,
  };
}

export function fakeSlack(overrides = {}) {
  let n = 0;
  return {
    authorizeUrl: ({ state, redirectUri }) => `https://slack.test/oauth/v2/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: vi.fn(async () => ({
      botToken: 'xoxb-test-bot-token',
      botUserId: 'UBOT',
      appId: 'AAPP',
      scopes: ['chat:write', 'chat:write.public', 'channels:read', 'groups:read'],
      team: { id: 'T123', name: 'Acme Slack' },
      enterprise: null,
    })),
    listChannels: vi.fn(async () => [
      { id: 'C0BACKEND', name: 'backend', isPrivate: false, isMember: true },
      { id: 'C0DEVOPS', name: 'devops', isPrivate: false, isMember: false },
    ]),
    postMessage: vi.fn(async () => ({ ts: `1700000000.${String(++n).padStart(6, '0')}` })),
    revoke: vi.fn(async () => {}),
    ...overrides,
  };
}

export function buildDeps({ github = fakeGitHub(), slack = fakeSlack(), queues = fakeQueues(), configOverrides = {} } = {}) {
  const config = { ...loadConfig(process.env), ...configOverrides };
  const deps = { config, db: testDb(), queues, github, slack };
  deps.registry = createRegistry({ config, slack });
  return deps;
}

export function buildApp(opts) {
  const deps = buildDeps(opts);
  return { deps, app: createApp(deps) };
}

let userSeq = 0;
export async function createUser(attrs = {}) {
  userSeq += 1;
  const [user] = await testDb()('users')
    .insert({ github_id: 90000 + userSeq, login: attrs.login || `user${userSeq}`, name: attrs.name || null, ...attrs })
    .returning('*');
  return user;
}

export async function createSession(user, config) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  await testDb()('sessions').insert({ user_id: user.id, token_hash: sha256(token), csrf_token: csrf, expires_at: new Date(Date.now() + 3600_000) });
  return { cookie: `${config.session.cookieName}=${token}`, csrf, token };
}

export async function createWorkspace(owner, attrs = {}) {
  const d = testDb();
  const [ws] = await d('workspaces')
    .insert({ name: attrs.name || 'Acme', slug: `acme-${randomToken(4).toLowerCase()}`, created_by: owner.id, ...attrs })
    .returning('*');
  await d('workspace_members').insert({ workspace_id: ws.id, user_id: owner.id, role: 'owner' });
  await d('reminder_policies').insert(DEFAULT_REMINDER_POLICIES.map((p) => ({ ...p, workspace_id: ws.id })));
  return ws;
}

export async function addMember(ws, user, role) {
  await testDb()('workspace_members').insert({ workspace_id: ws.id, user_id: user.id, role });
}

/** A workspace with a claimed GitHub installation, one monitored repo, and an active Slack channel. */
export async function seedConnectedWorkspace(config, { installationId = '555', repoExternalId = '1', repoName = 'acme/api', teamId = 'T123' } = {}) {
  const d = testDb();
  const owner = await createUser({ login: `owner-${installationId}` });
  const ws = await createWorkspace(owner, { name: `WS ${installationId}` });
  const [gh] = await d('integrations')
    .insert({ workspace_id: ws.id, provider: 'github', kind: 'source', external_id: installationId, status: 'active', display_name: 'acme', config: {} })
    .returning('*');
  const [repo] = await d('repositories')
    .insert({ workspace_id: ws.id, integration_id: gh.id, provider: 'github', external_id: repoExternalId, full_name: repoName, name: repoName.split('/')[1], owner_login: repoName.split('/')[0], default_branch: 'main', monitoring_enabled: true })
    .returning('*');
  const [slackInt] = await d('integrations')
    .insert({
      workspace_id: ws.id,
      provider: 'slack',
      kind: 'destination',
      external_id: teamId,
      status: 'active',
      display_name: 'Acme Slack',
      config: {},
      credentials_encrypted: encryptJson({ botToken: 'xoxb-seeded' }, config.encryptionKey),
    })
    .returning('*');
  const [channel] = await d('notification_channels')
    .insert({ workspace_id: ws.id, integration_id: slackInt.id, provider: 'slack', external_id: `C${installationId}`, name: 'backend' })
    .returning('*');
  const [devops] = await d('notification_channels')
    .insert({ workspace_id: ws.id, integration_id: slackInt.id, provider: 'slack', external_id: `D${installationId}`, name: 'devops' })
    .returning('*');
  await d('workspaces').where({ id: ws.id }).update({ default_channel_id: channel.id });
  const session = await createSession(owner, config);
  return { owner, ws: { ...ws, default_channel_id: channel.id }, gh, repo, slackInt, channel, devops, session };
}

export function authed(app, session) {
  const wrap = (method) => (url) => request(app)[method](url).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), delete: wrap('delete') };
}

let deliverySeq = 0;
export function sendWebhook(app, config, eventName, payload, { deliveryId, secret = config.github.webhookSecret, signature } = {}) {
  deliverySeq += 1;
  const body = Buffer.from(JSON.stringify(payload));
  const id = deliveryId || `00000000-0000-4000-8000-${String(deliverySeq).padStart(12, '0')}`;
  return request(app)
    .post('/api/v1/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', eventName)
    .set('X-GitHub-Delivery', id)
    .set('X-Hub-Signature-256', signature ?? signGitHubPayload(secret, body))
    .send(body.toString('utf8')); // a string is sent verbatim; a Buffer would be JSON-encoded by superagent
}

// ---- GitHub payload fixtures ----
export function installationObject(id = 555, extra = {}) {
  return {
    id: Number(id),
    account: { login: 'acme', id: 77, type: 'Organization' },
    repository_selection: 'selected',
    permissions: { metadata: 'read', pull_requests: 'read', issues: 'read', contents: 'read', actions: 'read', deployments: 'read' },
    events: ['pull_request', 'pull_request_review', 'issues', 'issue_comment', 'push', 'workflow_run', 'workflow_job', 'release', 'deployment', 'deployment_status', 'repository'],
    html_url: 'https://github.com/organizations/acme/settings/installations/555',
    suspended_at: null,
    ...extra,
  };
}

export function repoObject(id, fullName, extra = {}) {
  return {
    id,
    full_name: fullName,
    name: fullName.split('/')[1],
    owner: { login: fullName.split('/')[0] },
    private: true,
    archived: false,
    disabled: false,
    default_branch: 'main',
    html_url: `https://github.com/${fullName}`,
    ...extra,
  };
}

export function prObject(extra = {}) {
  return {
    id: 9001,
    number: 42,
    title: 'Add authentication',
    html_url: 'https://github.com/acme/api/pull/42',
    state: 'open',
    draft: false,
    merged: false,
    merged_at: null,
    user: { login: 'bob' },
    base: { ref: 'main' },
    head: { ref: 'feature/auth', sha: 'abc1234def5678' },
    requested_reviewers: [{ login: 'carol' }],
    requested_teams: [],
    labels: [],
    additions: 10,
    deletions: 2,
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    closed_at: null,
    ...extra,
  };
}

export function prPayload(action = 'opened', { installationId = 555, repoId = 1, repoName = 'acme/api', pr = {} } = {}) {
  return {
    action,
    pull_request: prObject(pr),
    repository: repoObject(repoId, repoName),
    installation: { id: installationId },
    sender: { login: 'bob', id: 2 },
  };
}

export function workflowRunPayload(conclusion = 'failure', { installationId = 555, repoId = 1, repoName = 'acme/api' } = {}) {
  return {
    action: 'completed',
    workflow_run: {
      id: 777,
      name: 'CI',
      run_number: 12,
      run_attempt: 1,
      status: 'completed',
      conclusion,
      head_branch: 'main',
      head_sha: 'deadbeefcafe',
      head_commit: { message: 'Fix tests\n\nmore' },
      event: 'push',
      html_url: 'https://github.com/acme/api/actions/runs/777',
      run_started_at: '2026-11-01T10:00:00Z',
      updated_at: '2026-11-01T10:03:30Z',
    },
    repository: repoObject(repoId, repoName),
    installation: { id: installationId },
    sender: { login: 'bob', id: 2 },
  };
}

export function issuePayload(action = 'opened', { installationId = 555, issue = {}, extra = {} } = {}) {
  return {
    action,
    issue: {
      id: 3001,
      number: 7,
      title: 'Login broken',
      html_url: 'https://github.com/acme/api/issues/7',
      state: 'open',
      user: { login: 'dave' },
      labels: [{ name: 'bug' }],
      assignees: [],
      comments: 0,
      created_at: '2026-11-01T09:00:00Z',
      updated_at: '2026-11-01T09:00:00Z',
      ...issue,
    },
    repository: repoObject(1, 'acme/api'),
    installation: { id: installationId },
    sender: { login: 'dave', id: 4 },
    ...extra,
  };
}
