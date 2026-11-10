import { sha256, safeEqual } from '../shared/crypto.js';
import { unauthorized, forbidden } from '../shared/errors.js';

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Loads the server-side session (if any) referenced by the HTTP-only session cookie. */
export function loadSession({ db, config }) {
  return async (req, res, next) => {
    const token = req.cookies?.[config.session.cookieName];
    if (!token || typeof token !== 'string' || token.length > 200) return next();

    const row = await db('sessions as s')
      .join('users as u', 'u.id', 's.user_id')
      .where('s.token_hash', sha256(token))
      .first(
        's.id as session_id',
        's.csrf_token',
        's.expires_at',
        's.last_seen_at',
        'u.id',
        'u.github_id',
        'u.login',
        'u.name',
        'u.email',
        'u.avatar_url',
      );
    if (!row) {
      clearSessionCookie(res, config);
      return next();
    }

    const now = Date.now();
    const idleLimit = config.session.idleHours * 3600 * 1000;
    if (new Date(row.expires_at).getTime() <= now || now - new Date(row.last_seen_at).getTime() > idleLimit) {
      await db('sessions').where({ id: row.session_id }).del();
      clearSessionCookie(res, config);
      return next();
    }

    if (now - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
      await db('sessions').where({ id: row.session_id }).update({ last_seen_at: db.fn.now() });
    }

    req.session = { id: row.session_id, csrfToken: row.csrf_token };
    req.user = {
      id: row.id,
      githubId: row.github_id,
      login: row.login,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatar_url,
    };
    next();
  };
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests:
 *  1. Synchronizer token: state-changing requests must echo the session's CSRF token in X-CSRF-Token.
 *  2. Origin check: if the browser sends Origin, it must be an allowed origin.
 * SameSite=Lax cookies provide a third layer.
 */
export function csrfProtection({ config }) {
  const allowed = new Set([config.appUrl, config.apiUrl, ...config.corsOrigins]);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin && !allowed.has(origin)) return next(forbidden('Cross-origin request rejected'));
    if (!req.session) return next(); // unauthenticated; requireAuth decides
    if (!safeEqual(req.get('x-csrf-token') || '', req.session.csrfToken)) {
      return next(forbidden('Missing or invalid CSRF token'));
    }
    next();
  };
}

export function sessionCookieOptions(config, maxAgeMs) {
  return {
    httpOnly: true,
    secure: config.session.secureCookies,
    sameSite: 'lax',
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

export function clearSessionCookie(res, config) {
  res.clearCookie(config.session.cookieName, sessionCookieOptions(config));
}
