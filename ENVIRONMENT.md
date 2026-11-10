# Environment configuration

All configuration is read from environment variables (or `backend/.env`, loaded by dotenv) and validated at startup by `backend/src/config/env.js`. Invalid or missing values stop the process with a readable list of problems.

In `NODE_ENV=production` the API and worker also **refuse to start** unless `API_URL`, every `GITHUB_APP_*` value and every `SLACK_*` value is set. In development these integrations may be left empty. The UI then shows them as "not configured".

Copy `backend/.env.example` to `backend/.env`. Never commit `.env` or key files; both are git-ignored.

## Core

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | | `development` | `development`, `test`, `production` |
| `PORT` | | `4000` | API port |
| `WORKER_HEALTH_PORT` | | `4001` | Worker `/healthz`, `/readyz`, `/metrics` |
| `LOG_LEVEL` | | `info` | pino level |
| `APP_URL` | **yes** | | Public URL of the web app. Used for post-OAuth redirects, invite links, and the default CORS origin |
| `API_URL` | prod | `APP_URL` | Public base URL for OAuth callbacks (`$API_URL/api/v1/...`). Same as `APP_URL` behind the bundled nginx or the Vite proxy |
| `CORS_ORIGINS` | | `APP_URL` | Extra allowed browser origins, comma-separated |
| `TRUST_PROXY` | | `loopback` | Express trust-proxy (`1` behind one proxy) so client IPs and rate limits are correct |
| `COOKIE_SECURE` | | auto | `true`/`false`. Auto means secure in production or when `APP_URL` is https. Secure cookies use the `__Host-` prefix |
| `DATABASE_URL` | **yes** | | PostgreSQL 15+ connection string (composite FKs use `ON DELETE SET NULL (col)`) |
| `DATABASE_POOL_MIN` / `DATABASE_POOL_MAX` | | `0` / `10` | Knex pool per process |
| `REDIS_URL` | **yes** | | Redis 6.2+ for BullMQ. Use `maxmemory-policy noeviction` |
| `ENCRYPTION_KEY` | **yes** | | 32 bytes, base64 (`openssl rand -base64 32`). AES-256-GCM key for Slack bot tokens. **Changing it makes stored tokens unreadable**, so reconnect Slack after rotating |
| `SESSION_TTL_HOURS` | | `168` | Absolute session lifetime |
| `SESSION_IDLE_HOURS` | | `72` | Idle timeout |

## GitHub App

One GitHub App provides user sign-in, organization installation, and webhooks. See SETUP.md for how to create it.

| Variable | Purpose |
|---|---|
| `GITHUB_APP_ID` | Numeric App ID |
| `GITHUB_APP_SLUG` | The app's URL name (`https://github.com/apps/<slug>`). Used to build the install link |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | The App's OAuth credentials, used for sign-in and installation-ownership checks |
| `GITHUB_APP_PRIVATE_KEY` | PEM contents (newlines may be `\n`). Preferred in containers and secret managers |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Alternative: path to the PEM file. Keep it **outside** the repository |
| `GITHUB_APP_WEBHOOK_SECRET` | Webhook secret configured on the App. Every webhook is HMAC-verified with it |
| `GITHUB_API_URL` / `GITHUB_WEB_URL` | Default `https://api.github.com` / `https://github.com` (override for GitHub Enterprise Server) |

## Slack app

| Variable | Purpose |
|---|---|
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | OAuth v2 credentials |
| `SLACK_SIGNING_SECRET` | Verifies Events API requests |
| `SLACK_API_URL` | Optional Web API base override (testing only) |

## Operations and tuning

| Variable | Default | Purpose |
|---|---|---|
| `METRICS_TOKEN` | (unset → `/metrics` disabled) | Bearer token for `/metrics` |
| `WEBHOOK_BODY_LIMIT` | `25mb` | Maximum webhook body (GitHub caps payloads at 25 MB). Larger requests get 413 |
| `JSON_BODY_LIMIT` | `1mb` | Maximum body for normal API requests |
| `WORKER_EVENT_CONCURRENCY` | `5` | Parallel webhook processing per worker |
| `WORKER_DELIVERY_CONCURRENCY` | `5` | Parallel Slack sends per worker |
| `EVENT_MAX_ATTEMPTS` | `8` | Attempts before a webhook delivery becomes `dead` (backoff 10 s × 2ⁿ, capped at 1 h) |
| `DELIVERY_MAX_ATTEMPTS` | `6` | Attempts before a notification becomes `dead` (backoff 15 s × 2ⁿ) |
| `WEBHOOK_PAYLOAD_RETENTION_DAYS` | `14` | Raw payloads of finished deliveries are deleted after this (normalized events are kept) |

## Frontend

| Variable | Purpose |
|---|---|
| `VITE_API_PROXY` | Dev only: where Vite proxies `/api` (default `http://localhost:4000`) |
| `VITE_API_BASE` | Build-time API origin when the API is **not** served on the same origin. Same-origin (default) is recommended, because cross-site cookies need `SameSite=None` and are not supported out of the box |

## Docker Compose overrides

`docker-compose.yml` reads `backend/.env` and overrides `DATABASE_URL`, `REDIS_URL`, `APP_URL`/`API_URL` (default `http://localhost:8080`), `NODE_ENV` (default `production`), and `TRUST_PROXY=1`. Optional shell variables: `POSTGRES_PASSWORD`, `WEB_PORT`, `COOKIE_SECURE`.
