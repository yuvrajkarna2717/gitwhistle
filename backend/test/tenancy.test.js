import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp, resetDb, testDb, createUser, createSession, addMember, authed, seedConnectedWorkspace } from './helpers.js';

describe('workspaces, roles and tenant isolation', () => {
  beforeEach(resetDb);

  it('creates a workspace with the creator as owner and default reminder policies', async () => {
    const { app, deps } = buildApp();
    const user = await createUser();
    const s = await createSession(user, deps.config);
    const res = await authed(app, s).post('/api/v1/workspaces').send({ name: 'Platform Team', timezone: 'Europe/Berlin' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Platform Team', role: 'owner', timezone: 'Europe/Berlin' });
    expect(await testDb()('reminder_policies').where({ workspace_id: res.body.data.id }).count({ n: '*' }).first()).toEqual({ n: 3 });
    expect((await authed(app, s).post('/api/v1/workspaces').send({ name: 'Mars team', timezone: 'Mars/Base' })).status).toBe(400);
    expect((await authed(app, s).post('/api/v1/workspaces').send({ name: '' })).status).toBe(422);
  });

  it('prevents workspace A from reading or changing workspace B data', async () => {
    const { app, deps } = buildApp();
    const a = await seedConnectedWorkspace(deps.config, { installationId: '1', repoExternalId: '10', repoName: 'a/repo', teamId: 'TA' });
    const b = await seedConnectedWorkspace(deps.config, { installationId: '2', repoExternalId: '20', repoName: 'b/repo', teamId: 'TB' });
    await testDb()('events').insert({ workspace_id: b.ws.id, source: 'github', event_type: 'push', provider_event_id: 'x1', repository_id: b.repo.id, occurred_at: new Date(), received_at: new Date() });
    const [bRule] = await testDb()('notification_rules').insert({ workspace_id: b.ws.id, name: 'B rule', actions: { channelIds: [b.channel.id] } }).returning('*');

    const asA = authed(app, a.session);
    // Direct access to B's workspace looks like it does not exist.
    for (const path of ['', '/repositories', '/events', '/channels', '/notification-rules', '/pull-requests', '/issues', '/overview', '/integrations', '/members']) {
      const res = await asA.get(`/api/v1/workspaces/${b.ws.id}${path}`);
      expect(res.status, path).toBe(404);
    }
    // A's own listings never include B's rows.
    const repos = await asA.get(`/api/v1/workspaces/${a.ws.id}/repositories`);
    expect(repos.body.data.map((r) => r.fullName)).toEqual(['a/repo']);
    expect((await asA.get(`/api/v1/workspaces/${a.ws.id}/events`)).body.data).toEqual([]);

    // Cross-tenant ids inside A's scope are rejected.
    expect((await asA.patch(`/api/v1/workspaces/${a.ws.id}/repositories/${b.repo.id}`).send({ monitoringEnabled: false })).status).toBe(404);
    expect((await asA.patch(`/api/v1/workspaces/${a.ws.id}/notification-rules/${bRule.id}`).send({ name: 'pwned' })).status).toBe(404);
    expect((await asA.delete(`/api/v1/workspaces/${a.ws.id}/channels/${b.channel.id}`)).status).toBe(404);
    const crossRule = await asA.post(`/api/v1/workspaces/${a.ws.id}/notification-rules`).send({ name: 'steal', actions: { channelIds: [b.channel.id] } });
    expect(crossRule.status).toBe(400);
    const crossDefault = await asA.patch(`/api/v1/workspaces/${a.ws.id}`).send({ defaultChannelId: b.channel.id });
    expect(crossDefault.status).toBe(400);
    expect((await testDb()('notification_rules').where({ id: bRule.id }).first()).name).toBe('B rule');
  });

  it('enforces database-level tenant constraints even if application code is wrong', async () => {
    const { deps } = buildApp();
    const a = await seedConnectedWorkspace(deps.config, { installationId: '1', repoExternalId: '10', teamId: 'TA' });
    const b = await seedConnectedWorkspace(deps.config, { installationId: '2', repoExternalId: '20', teamId: 'TB' });
    await expect(testDb()('repositories').where({ id: a.repo.id }).update({ default_channel_id: b.channel.id })).rejects.toThrow(/foreign key/);
    await expect(
      testDb()('notification_deliveries').insert({ workspace_id: a.ws.id, kind: 'event', channel_id: b.channel.id, provider: 'slack', dedupe_key: 'x', message: {} }),
    ).rejects.toThrow(/foreign key/);
  });

  it('restricts integration, rule and member administration by role', async () => {
    const { app, deps } = buildApp();
    const a = await seedConnectedWorkspace(deps.config);
    const member = await createUser({ login: 'mallory' });
    await addMember(a.ws, member, 'member');
    const asMember = authed(app, await createSession(member, deps.config));
    const base = `/api/v1/workspaces/${a.ws.id}`;

    expect((await asMember.get(`${base}/repositories`)).status).toBe(200); // read is fine
    expect((await asMember.get(`${base}/integrations/github/install`)).status).toBe(403);
    expect((await asMember.get(`${base}/integrations/slack/connect`)).status).toBe(403);
    expect((await asMember.delete(`${base}/integrations/${a.slackInt.id}`)).status).toBe(403);
    expect((await asMember.post(`${base}/notification-rules`).send({ name: 'r', actions: { channelIds: [a.channel.id] } })).status).toBe(403);
    expect((await asMember.patch(`${base}/repositories/${a.repo.id}`).send({ monitoringEnabled: false })).status).toBe(403);
    expect((await asMember.post(`${base}/invitations`).send({ role: 'admin' })).status).toBe(403);
    expect((await asMember.patch(`${base}/members/${member.id}`).send({ role: 'owner' })).status).toBe(403);
    expect((await asMember.patch(base).send({ name: 'Mine now' })).status).toBe(403);

    // The last owner cannot be demoted or removed.
    const asOwner = authed(app, a.session);
    expect((await asOwner.patch(`${base}/members/${a.owner.id}`).send({ role: 'admin' })).status).toBe(409);
    expect((await asOwner.delete(`${base}/members/${a.owner.id}`)).status).toBe(409);
  });

  it('supports single-use invitations, optionally restricted to a GitHub login', async () => {
    const { app, deps } = buildApp();
    const a = await seedConnectedWorkspace(deps.config);
    const asOwner = authed(app, a.session);
    const inv = await asOwner.post(`/api/v1/workspaces/${a.ws.id}/invitations`).send({ role: 'admin', githubLogin: 'Erin' });
    expect(inv.status).toBe(201);
    const token = inv.body.data.url.split('/invite/')[1];

    const wrongUser = authed(app, await createSession(await createUser({ login: 'frank' }), deps.config));
    expect((await wrongUser.post('/api/v1/invitations/accept').send({ token })).status).toBe(403);

    const erin = await createUser({ login: 'erin' });
    const asErin = authed(app, await createSession(erin, deps.config));
    expect((await asErin.post('/api/v1/invitations/preview').send({ token })).body.data).toMatchObject({ role: 'admin' });
    expect((await asErin.post('/api/v1/invitations/accept').send({ token })).status).toBe(200);
    expect((await asErin.post('/api/v1/invitations/accept').send({ token })).status).toBe(404);
    expect((await asErin.get(`/api/v1/workspaces/${a.ws.id}/repositories`)).status).toBe(200);
    expect(await testDb()('audit_logs').where({ action: 'invitation.accepted' }).count({ n: '*' }).first()).toEqual({ n: 1 });
  });
});
