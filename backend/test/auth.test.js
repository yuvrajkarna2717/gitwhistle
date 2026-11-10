import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, resetDb, testDb, createUser, createSession, authed } from './helpers.js';

function cookiesFrom(res) {
  return (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
}

async function startLogin(app) {
  const res = await request(app).get('/api/v1/auth/github/login?returnTo=/w/abc');
  const state = new URL(res.headers.location).searchParams.get('state');
  return { res, state, cookies: cookiesFrom(res) };
}

describe('GitHub OAuth login and sessions', () => {
  beforeEach(resetDb);

  it('redirects to GitHub with single-use state bound to the browser', async () => {
    const { app } = buildApp();
    const { res, state, cookies } = await startLogin(app);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('redirect_uri=');
    expect(state.length).toBeGreaterThan(30);
    expect(cookies.some((c) => c.startsWith('gw_oauth_login='))).toBe(true);
    const row = await testDb()('oauth_states').first();
    expect(row.state_hash).not.toBe(state); // only the hash is stored
  });

  it('creates a user and a working session on first login (Knex returning objects handled)', async () => {
    const { app, deps } = buildApp();
    const { state, cookies } = await startLogin(app);
    const cb = await request(app).get(`/api/v1/auth/github/callback?code=abc&state=${state}`).set('Cookie', cookies.join('; '));
    expect(cb.status).toBe(303);
    expect(cb.headers.location).toBe('http://localhost:5173/w/abc');
    const session = cookiesFrom(cb).find((c) => c.startsWith('gw_session='));
    expect(session).toBeTruthy();
    expect(cb.headers['set-cookie'].join(';')).toMatch(/HttpOnly/i);
    expect(cb.headers['set-cookie'].join(';')).toMatch(/SameSite=Lax/i);

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', session);
    expect(me.status).toBe(200);
    expect(me.body.data.user).toMatchObject({ login: 'alice', email: 'alice@example.com' });
    expect(me.body.data.csrfToken).toBeTruthy();
    expect(JSON.stringify(me.body)).not.toContain('gho_user_token'); // GitHub token never stored or returned
    expect(deps.github.exchangeCode).toHaveBeenCalledOnce();
    const sessionRow = await testDb()('sessions').first();
    expect(sessionRow.token_hash).toHaveLength(64);
  });

  it('rejects replayed, unknown, and wrong-browser state', async () => {
    const { app } = buildApp();
    const { state, cookies } = await startLogin(app);
    await request(app).get(`/api/v1/auth/github/callback?code=abc&state=${state}`).set('Cookie', cookies.join('; '));
    const replay = await request(app).get(`/api/v1/auth/github/callback?code=abc&state=${state}`).set('Cookie', cookies.join('; '));
    expect(replay.headers.location).toContain('error=invalid_state');

    const unknown = await request(app).get('/api/v1/auth/github/callback?code=abc&state=nope-nope-nope-nope-nope-nope');
    expect(unknown.headers.location).toContain('error=invalid_state');

    const second = await startLogin(app);
    const noBinding = await request(app).get(`/api/v1/auth/github/callback?code=abc&state=${second.state}`);
    expect(noBinding.headers.location).toContain('error=invalid_state');
    expect(await testDb()('users').count({ n: '*' }).first()).toEqual({ n: 1 });
  });

  it('handles cancelled authorization', async () => {
    const { app, deps } = buildApp();
    const { state, cookies } = await startLogin(app);
    const res = await request(app).get(`/api/v1/auth/github/callback?error=access_denied&state=${state}`).set('Cookie', cookies.join('; '));
    expect(res.headers.location).toBe('http://localhost:5173/login?error=access_denied');
    expect(deps.github.exchangeCode).not.toHaveBeenCalled();
  });

  it('only redirects to same-app relative paths after login', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/auth/github/login?returnTo=//evil.example.com');
    const state = new URL(res.headers.location).searchParams.get('state');
    const cb = await request(app).get(`/api/v1/auth/github/callback?code=abc&state=${state}`).set('Cookie', cookiesFrom(res).join('; '));
    expect(cb.headers.location).toBe('http://localhost:5173/');
  });

  it('requires authentication, enforces CSRF on mutations, and logs out', async () => {
    const { app, deps } = buildApp();
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/workspaces')).status).toBe(401);

    const user = await createUser();
    const s = await createSession(user, deps.config);
    const noCsrf = await request(app).post('/api/v1/workspaces').set('Cookie', s.cookie).send({ name: 'Team' });
    expect(noCsrf.status).toBe(403);
    const badOrigin = await authed(app, s).post('/api/v1/workspaces').set('Origin', 'https://evil.example').send({ name: 'Team' });
    expect(badOrigin.status).toBe(403);
    expect((await authed(app, s).post('/api/v1/workspaces').send({ name: 'Team' })).status).toBe(201);

    expect((await authed(app, s).post('/api/v1/auth/logout')).status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', s.cookie)).status).toBe(401);
  });

  it('expires sessions by absolute and idle timeouts', async () => {
    const { app, deps } = buildApp();
    const user = await createUser();
    const s = await createSession(user, deps.config);
    await testDb()('sessions').update({ expires_at: new Date(Date.now() - 1000) });
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', s.cookie)).status).toBe(401);
    expect(await testDb()('sessions').count({ n: '*' }).first()).toEqual({ n: 0 });

    const s2 = await createSession(user, deps.config);
    await testDb()('sessions').update({ last_seen_at: new Date(Date.now() - 100 * 3600_000) });
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', s2.cookie)).status).toBe(401);
  });
});
