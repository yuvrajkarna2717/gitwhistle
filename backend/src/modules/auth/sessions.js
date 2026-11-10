import { randomToken, sha256 } from '../../shared/crypto.js';
import { sessionCookieOptions, clearSessionCookie } from '../../middleware/session.js';

export async function upsertGitHubUser(db, ghUser) {
  const [user] = await db('users')
    .insert({
      github_id: ghUser.id,
      login: ghUser.login,
      name: ghUser.name,
      email: ghUser.email,
      avatar_url: ghUser.avatarUrl,
      last_login_at: db.fn.now(),
    })
    .onConflict('github_id')
    .merge(['login', 'name', 'email', 'avatar_url', 'last_login_at', 'updated_at'])
    .returning(['id', 'login']);
  return user; // { id, login } — returning() yields row objects, never bare values
}

export async function createSession({ db, config }, req, res, userId) {
  const token = randomToken(32);
  const ttlMs = config.session.ttlHours * 3600 * 1000;
  const [session] = await db('sessions')
    .insert({
      user_id: userId,
      token_hash: sha256(token),
      csrf_token: randomToken(24),
      expires_at: new Date(Date.now() + ttlMs),
      ip: req.ip?.slice(0, 64),
      user_agent: req.get('user-agent')?.slice(0, 512),
    })
    .returning(['id']);
  res.cookie(config.session.cookieName, token, sessionCookieOptions(config, ttlMs));
  return session;
}

export async function destroySession({ db, config }, req, res) {
  if (req.session) await db('sessions').where({ id: req.session.id }).del();
  clearSessionCookie(res, config);
}

export async function purgeExpiredSessions(db) {
  return db('sessions').where('expires_at', '<', db.fn.now()).del();
}
