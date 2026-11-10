/**
 * Centralized API client. Authentication uses an HTTP-only session cookie (never readable here);
 * state-changing requests echo the CSRF token returned by /auth/me.
 */
const BASE = import.meta.env.VITE_API_BASE || '';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let csrfToken = null;
let onUnauthorized = null;

export function setCsrfToken(token) {
  csrfToken = token;
}

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function apiRequest(method, path, { body, query, signal } = {}) {
  const url = new URL(`${BASE}/api/v1${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Could not reach the GitWhistle server. Check your connection and try again.');
  }

  if (res.status === 204) return { data: null };
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON (e.g. proxy error page)
  }
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized && path !== '/auth/me') onUnauthorized();
    const e = json?.error || {};
    throw new ApiError(res.status, e.code || 'http_error', e.message || `Request failed (${res.status})`, e.details);
  }
  return json ?? { data: null };
}

export const api = {
  get: (path, query, opts) => apiRequest('GET', path, { query, ...opts }),
  post: (path, body) => apiRequest('POST', path, { body: body ?? {} }),
  patch: (path, body) => apiRequest('PATCH', path, { body }),
  put: (path, body) => apiRequest('PUT', path, { body }),
  delete: (path) => apiRequest('DELETE', path),
};

/** Full-page navigations for OAuth flows (the server redirects to GitHub / Slack). */
export const oauthUrls = {
  login: (returnTo = '/') => `${BASE}/api/v1/auth/github/login?returnTo=${encodeURIComponent(returnTo)}`,
  installGitHub: (workspaceId) => `${BASE}/api/v1/workspaces/${workspaceId}/integrations/github/install`,
  connectSlack: (workspaceId) => `${BASE}/api/v1/workspaces/${workspaceId}/integrations/slack/connect`,
};
