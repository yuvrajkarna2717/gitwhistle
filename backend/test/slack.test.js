import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, resetDb, testDb, createUser, createSession, createWorkspace, authed, seedConnectedWorkspace } from './helpers.js';
import { signSlackPayload } from '../src/modules/slack/signature.js';
import { decryptJson } from '../src/shared/crypto.js';

const cookiesFrom = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);

describe('Slack integration', () => {
  beforeEach(resetDb);

  async function connect(ctx) {
    const start = await authed(ctx.app, ctx.session).get(`/api/v1/workspaces/${ctx.ws.id}/integrations/slack/connect`);
    expect(start.status).toBe(302);
    const url = new URL(start.headers.location);
    const state = url.searchParams.get('state');
    return request(ctx.app)
      .get(`/api/v1/integrations/slack/callback?code=slack-code&state=${state}`)
      .set('Cookie', [ctx.session.cookie, ...cookiesFrom(start)].join('; '));
  }

  async function ctxWithAdmin() {
    const ctx = buildApp();
    const user = await createUser();
    const ws = await createWorkspace(user);
    return { ...ctx, user, ws, session: await createSession(user, ctx.deps.config) };
  }

  it('installs via OAuth, stores the bot token encrypted, and never exposes it', async () => {
    const ctx = await ctxWithAdmin();
    const res = await connect(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('slack=connected');
    const row = await testDb()('integrations').where({ provider: 'slack' }).first();
    expect(row).toMatchObject({ workspace_id: ctx.ws.id, external_id: 'T123', status: 'active', display_name: 'Acme Slack' });
    expect(row.credentials_encrypted).not.toContain('xoxb');
    expect(decryptJson(row.credentials_encrypted, ctx.deps.config.encryptionKey)).toEqual({ botToken: 'xoxb-test-bot-token' });

    const list = await authed(ctx.app, ctx.session).get(`/api/v1/workspaces/${ctx.ws.id}/integrations`);
    expect(list.body.data.integrations[0].details.scopes).toContain('chat:write');
    expect(JSON.stringify(list.body)).not.toMatch(/xoxb|credentials/);
  });

  it('rejects callbacks with invalid or replayed state and handles cancellation', async () => {
    const ctx = await ctxWithAdmin();
    const bad = await request(ctx.app).get('/api/v1/integrations/slack/callback?code=x&state=forged-forged-forged-forged').set('Cookie', ctx.session.cookie);
    expect(bad.headers.location).toContain('error=invalid_state');

    const start = await authed(ctx.app, ctx.session).get(`/api/v1/workspaces/${ctx.ws.id}/integrations/slack/connect`);
    const state = new URL(start.headers.location).searchParams.get('state');
    const jar = [ctx.session.cookie, ...cookiesFrom(start)].join('; ');
    const denied = await request(ctx.app).get(`/api/v1/integrations/slack/callback?error=access_denied&state=${state}`).set('Cookie', jar);
    expect(denied.headers.location).toContain('error=slack_access_denied');
    const replay = await request(ctx.app).get(`/api/v1/integrations/slack/callback?code=x&state=${state}`).set('Cookie', jar);
    expect(replay.headers.location).toContain('error=invalid_state');
    expect(ctx.deps.slack.exchangeCode).not.toHaveBeenCalled();
  });

  it('rejects a callback completed by a different logged-in user than the one who started it', async () => {
    const ctx = await ctxWithAdmin();
    const start = await authed(ctx.app, ctx.session).get(`/api/v1/workspaces/${ctx.ws.id}/integrations/slack/connect`);
    const state = new URL(start.headers.location).searchParams.get('state');
    const other = await createSession(await createUser(), ctx.deps.config);
    const res = await request(ctx.app)
      .get(`/api/v1/integrations/slack/callback?code=x&state=${state}`)
      .set('Cookie', [other.cookie, ...cookiesFrom(start)].join('; '));
    expect(res.headers.location).toContain('error=invalid_state');
  });

  it('discovers channels and only adds channels Slack reports', async () => {
    const ctx = await ctxWithAdmin();
    await connect(ctx);
    const base = `/api/v1/workspaces/${ctx.ws.id}`;
    const avail = await authed(ctx.app, ctx.session).get(`${base}/integrations/slack/channels`);
    expect(avail.body.data.map((c) => c.name)).toEqual(['backend', 'devops']);
    expect((await authed(ctx.app, ctx.session).post(`${base}/channels`).send({ externalIds: ['C0NOTREAL'] })).status).toBe(400);
    const added = await authed(ctx.app, ctx.session).post(`${base}/channels`).send({ externalIds: ['C0BACKEND', 'C0DEVOPS'] });
    expect(added.status).toBe(201);
    expect((await testDb()('workspaces').where({ id: ctx.ws.id }).first()).default_channel_id).toBe(added.body.data[0].id);

    const test = await authed(ctx.app, ctx.session).post(`${base}/channels/${added.body.data[0].id}/test`);
    expect(test.body.data.outcome).toBe('sent');
    expect(ctx.deps.slack.postMessage).toHaveBeenCalledWith('xoxb-test-bot-token', expect.objectContaining({ channel: 'C0BACKEND' }));
  });

  it('disconnect revokes the token, wipes credentials, and disables channels', async () => {
    const ctx = buildApp();
    const s = await seedConnectedWorkspace(ctx.deps.config);
    const res = await authed(ctx.app, s.session).delete(`/api/v1/workspaces/${s.ws.id}/integrations/${s.slackInt.id}`);
    expect(res.status).toBe(204);
    expect(ctx.deps.slack.revoke).toHaveBeenCalledWith('xoxb-seeded');
    const row = await testDb()('integrations').where({ id: s.slackInt.id }).first();
    expect(row).toMatchObject({ status: 'disconnected', credentials_encrypted: null });
    expect(await testDb()('notification_channels').where({ integration_id: s.slackInt.id, enabled: true }).count({ n: '*' }).first()).toEqual({ n: 0 });
  });

  describe('Events API endpoint', () => {
    const post = (app, body, { secret = 'slack-signing-secret', ts = String(Math.floor(Date.now() / 1000)) } = {}) => {
      const raw = JSON.stringify(body);
      return request(app)
        .post('/api/v1/webhooks/slack/events')
        .set('Content-Type', 'application/json')
        .set('X-Slack-Request-Timestamp', ts)
        .set('X-Slack-Signature', signSlackPayload(secret, raw, ts))
        .send(raw);
    };

    it('verifies signatures and answers URL verification', async () => {
      const { app } = buildApp();
      expect((await post(app, { type: 'url_verification', challenge: 'abc' }, { secret: 'wrong' })).status).toBe(401);
      expect((await post(app, { type: 'url_verification', challenge: 'abc' }, { ts: '1000' })).status).toBe(401);
      const ok = await post(app, { type: 'url_verification', challenge: 'abc' });
      expect(ok.body).toEqual({ challenge: 'abc' });
    });

    it('marks the integration revoked on app_uninstalled', async () => {
      const ctx = buildApp();
      const s = await seedConnectedWorkspace(ctx.deps.config);
      await post(ctx.app, { type: 'event_callback', team_id: 'T123', event: { type: 'app_uninstalled' } });
      const row = await testDb()('integrations').where({ id: s.slackInt.id }).first();
      expect(row).toMatchObject({ status: 'revoked', credentials_encrypted: null });
    });
  });
});
