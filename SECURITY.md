# Security

## Immediate action required (from the November 2026 audit)

The prototype committed `backend/keys/github_app.pem`, a GitHub App private key, to the **public** repository `yuvrajkarna2717/gitwhistle` in commit `99baa6a` (2026-09-09).

This change removes the file from version control (`git rm --cached`) and ignores `keys/` and `*.pem`. **That alone does not make the key safe.** It is still in git history and may already have been copied. You must:

1. GitHub → Developer settings → GitHub Apps → your app → **Private keys** → delete the leaked key and generate a new one.
2. Store the new key outside the repository (`GITHUB_APP_PRIVATE_KEY` from a secret manager, or a file path outside the repo).
3. Optionally purge it from history (`git filter-repo --path backend/keys/github_app.pem --invert-paths`, then force-push). Do this only after rotating, and coordinate with anyone who has clones.
4. If the prototype's OAuth client secret was ever shared, rotate it as well.

## Controls in place

| Area | Control | Where |
|---|---|---|
| Webhook authenticity | HMAC-SHA256 over the **raw** body, constant-time compare. Missing, malformed or forged signatures → 401 with nothing stored | `github/signature.js`, `github/webhookRoutes.js` |
| Slack request authenticity | v0 signature over `v0:ts:body`, ±5 min timestamp window (anti-replay) | `slack/signature.js` |
| User auth | GitHub OAuth (GitHub App user authorization). Server-side sessions; only `sha256(token)` is stored. HTTP-only, `SameSite=Lax`, `Secure` + `__Host-` prefix when secure. Absolute (7 d) and idle (72 h) expiry. Logout deletes the session. A new session is issued on every login | `auth/*`, `middleware/session.js` |
| OAuth state | 256-bit random, hash stored, 10-min expiry, **atomically consumed** (no replay), bound to the browser by an HTTP-only cookie and, for integration flows, to the session and user | `auth/oauthState.js` |
| GitHub installation ownership | The `installation_id` from GitHub's redirect is not trusted. The user's own token must list it in `GET /user/installations`, the GitHub user must match the signed-in user, and the user must be a workspace admin | `github/installations.js#completeInstallationClaim` |
| CSRF | Synchronizer token (`X-CSRF-Token`) on all state-changing requests, plus an Origin allow-list, plus SameSite cookies | `middleware/session.js` |
| Authorization | Membership checked in the DB per request. Roles owner > admin > member. Non-members get 404. Last-owner protection | `middleware/workspaceAccess.js`, routes |
| Tenant isolation | `workspace_id` scoping on every query, re-validation of referenced ids, and **composite FKs** in the database | migrations, `test/tenancy.test.js` |
| Secrets at rest | Slack bot tokens encrypted with AES-256-GCM (`ENCRYPTION_KEY`). GitHub user tokens are used once and never stored. Installation tokens are minted per request by `@octokit/auth-app` and cached in memory only | `shared/crypto.js` |
| Secrets in transit to the browser | No API returns tokens or credentials (asserted in tests) | `integrations/routes.js` |
| Token revocation | Slack `app_uninstalled`/`tokens_revoked` events and `invalid_auth`/`token_revoked` API errors mark the integration `revoked`. Disconnect calls `auth.revoke` and wipes credentials | `slack/eventRoutes.js`, `notifications/deliveries.js` |
| Input validation | zod schemas for every body, query and path parameter. Rule conditions use a closed field and operator set with no `eval`. Globs are escaped. Parameterised SQL via Knex | `shared/validate.js`, `rules/schema.js` |
| Open redirects | `returnTo` must be a same-app relative path | `auth/routes.js#safeReturnTo` |
| Rate limiting | Per-IP: auth 60/min, API 600/min, GitHub webhooks 3000/min, Slack events 600/min | `app.js` |
| Headers | helmet (API CSP `default-src 'none'`). nginx adds CSP, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy | `app.js`, `client/nginx.conf` |
| CORS | Allow-list (`APP_URL` + `CORS_ORIGINS`), credentials only for those | `app.js` |
| Error responses | Generic 500 body. Details only in logs | `middleware/errorHandler.js` |
| Logging | Query strings (OAuth codes and state), cookies, auth/signature headers and token-like fields are redacted. Payloads are not logged. Error summaries drop request configs | `shared/logger.js` |
| Audit log | Workspace create/update, member role/removal, invitations, integration connect/disconnect, channel, repository and rule changes, reminder policy changes, reprocess and retry, test digests | `shared/audit.js` |
| Containers | Non-root user, production dependencies only, `.dockerignore` excludes `.env`, `keys/`, `*.pem` (CI asserts this) | Dockerfiles, CI |
| Dependencies | `npm audit` clean at the time of writing (backend production deps and client). CI fails on high-severity advisories | `.github/workflows/ci.yml` |

## Assumptions

- TLS is terminated in front of the app, and `TRUST_PROXY` is set correctly. Otherwise client IPs (rate limits, audit logs) are wrong.
- The web app and API are served from one origin. Cross-site deployments would need `SameSite=None` cookies and stricter CSRF handling, which are not implemented.
- PostgreSQL and Redis are on a private network. Redis has no auth in the bundled compose file.
- `ENCRYPTION_KEY` is managed as a secret. Anyone with it and the database can read Slack bot tokens.

## Known risks and limitations

- **At-least-once Slack delivery**: a worker crash between Slack accepting a message and the DB update can produce one duplicate message after a 10-minute recovery window.
- **Rate limiting is per process (in memory).** With several API replicas the effective limit multiplies. Use a Redis store or edge rate limiting at scale.
- **Encryption key rotation** is not automated. Rotating `ENCRYPTION_KEY` requires reconnecting Slack.
- **Installation hand-over**: if workspace A disconnects a GitHub installation, an admin of workspace B who also has GitHub access to it can claim it, and A's repository-linked PR/issue rows for it are deleted.
- **Webhook payload retention**: raw payloads (which contain repository content such as PR bodies and commit messages) are kept for `WEBHOOK_PAYLOAD_RETENTION_DAYS` (14). Normalized events keep titles, branch names and short excerpts indefinitely. Account and data deletion beyond deleting a workspace is not implemented.
- No 2FA or SSO enforcement beyond what GitHub provides. No session listing or remote revocation UI.
- Slack token rotation (refresh tokens) is not supported. Keep it disabled on the Slack app.

## Reporting

Report vulnerabilities privately to the maintainer, not in public issues.
