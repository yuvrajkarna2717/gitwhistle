import { randomToken, sha256, safeEqual } from '../../shared/crypto.js';
import { badRequest } from '../../shared/errors.js';
import { sessionCookieOptions } from '../../middleware/session.js';

const STATE_TTL_MINUTES = 10;

const cookieName = (config, purpose) => `${config.session.oauthCookieName}_${purpose}`;

/**
 * Creates single-use OAuth state bound to (a) this browser via an HTTP-only cookie and
 * (b) the current session when one exists. Only hashes are stored.
 */
export async function createOAuthState(
  { db, config },
  res,
  { purpose, sessionId = null, userId = null, workspaceId = null, data = {} },
) {
  const state = randomToken(32);
  const binding = randomToken(32);
  await db('oauth_states').insert({
    state_hash: sha256(state),
    browser_binding_hash: sha256(binding),
    purpose,
    session_id: sessionId,
    user_id: userId,
    workspace_id: workspaceId,
    data,
    expires_at: new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000),
  });
  res.cookie(cookieName(config, purpose), binding, sessionCookieOptions(config, STATE_TTL_MINUTES * 60 * 1000));
  return state;
}

/**
 * Atomically consumes state. Rejects unknown, expired, replayed, wrong-purpose, wrong-browser,
 * and wrong-session state. Consumption happens before validation so a state can never be retried.
 */
export async function consumeOAuthState({ db, config }, req, res, { state, purposes }) {
  if (typeof state !== 'string' || state.length < 20 || state.length > 200) throw badRequest('Invalid OAuth state');
  const [row] = await db('oauth_states')
    .where({ state_hash: sha256(state) })
    .whereIn('purpose', purposes)
    .whereNull('consumed_at')
    .where('expires_at', '>', db.fn.now())
    .update({ consumed_at: db.fn.now() })
    .returning('*');
  if (!row) throw badRequest('OAuth state is invalid, expired, or has already been used');

  const binding = req.cookies?.[cookieName(config, row.purpose)];
  res.clearCookie(cookieName(config, row.purpose), sessionCookieOptions(config));
  if (!binding || !safeEqual(sha256(binding), row.browser_binding_hash || '')) {
    throw badRequest('OAuth state was not issued to this browser');
  }
  if (row.session_id && row.session_id !== req.session?.id) {
    throw badRequest('OAuth state does not belong to the current session');
  }
  return row;
}

export async function purgeExpiredOAuthStates(db) {
  return db('oauth_states')
    .where('expires_at', '<', db.raw("now() - interval '1 day'"))
    .del();
}
