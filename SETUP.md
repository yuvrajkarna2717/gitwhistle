# Setup

## Prerequisites

- Node.js 22+ (developed on Node 24)
- PostgreSQL 15+ and Redis 6.2+ for running the app. The **test suite needs neither**: it starts a throwaway PostgreSQL via `embedded-postgres` and fakes Redis, GitHub and Slack.
- A GitHub account that can create GitHub Apps, and a Slack workspace where you can install apps
- For webhooks during local development, a public HTTPS tunnel to your machine (e.g. `cloudflared tunnel --url http://localhost:5173`, `ngrok http 5173`, or `smee.io`)

## 1. Run locally

```bash
# install
cd backend && npm ci && cd ../client && npm ci && cd ..

# configure
cp backend/.env.example backend/.env
#   set DATABASE_URL, REDIS_URL, ENCRYPTION_KEY (openssl rand -base64 32)
#   APP_URL=API_URL=http://localhost:5173 (or your tunnel URL, see below)

# database
cd backend && npm run migrate

# three terminals
npm run dev            # API on :4000         (backend/)
npm run dev:worker     # worker, health :4001 (backend/)
cd ../client && npm run dev   # web on :5173, proxies /api to :4000
```

Open http://localhost:5173. Without GitHub and Slack credentials the app starts, but sign-in is unavailable until the GitHub App is configured.

### Using a tunnel

GitHub must reach your webhook endpoint, and GitHub/Slack OAuth must redirect to a URL they accept (Slack requires HTTPS). The simplest setup is to tunnel the Vite server and use the tunnel URL everywhere:

```
APP_URL=https://<your-tunnel-host>
API_URL=https://<your-tunnel-host>
```

Vite proxies `/api` to the API, so webhooks, OAuth callbacks and the UI share one origin. Add the tunnel host to `server.allowedHosts` in `client/vite.config.js` if Vite rejects it.

## 2. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App** (create it under the organization if the org will own it).

| Setting | Value |
|---|---|
| Homepage URL | `$APP_URL` |
| Callback URL | `$API_URL/api/v1/auth/github/callback` |
| Expire user authorization tokens | on (tokens are used once and never stored) |
| Request user authorization (OAuth) during installation | **off** (GitWhistle runs its own verification step) |
| Setup URL | `$API_URL/api/v1/integrations/github/setup` |
| Redirect on update | on |
| Webhook | Active. URL `$API_URL/api/v1/webhooks/github`. Secret: a long random string → `GITHUB_APP_WEBHOOK_SECRET` |

**Repository permissions (all Read-only):** Metadata, Pull requests, Issues, Contents, Actions, Deployments.
**Account permissions:** Email addresses (Read-only). Optional; used to show the user's email.

**Subscribe to events:** Pull request, Pull request review, Issues, Issue comment, Push, Workflow run, Workflow job, Release, Deployment, Deployment status, Repository.

After creating the app:

- Note the **App ID**, **Client ID** and the app's URL slug → `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`.
- Generate a **client secret** → `GITHUB_APP_CLIENT_SECRET`.
- Generate a **private key**. Store it outside the repository (secret manager, or a file referenced by `GITHUB_APP_PRIVATE_KEY_PATH`), or put the PEM into `GITHUB_APP_PRIVATE_KEY`.
- Under *Install App*, choose "Any account" if other organizations should be able to install it.

If permissions are missing, the Integrations page shows which ones after installation.

## 3. Create the Slack app

https://api.slack.com/apps → **Create New App** → From scratch.

| Setting | Value |
|---|---|
| OAuth & Permissions → Redirect URL | `$API_URL/api/v1/integrations/slack/callback` |
| Bot token scopes | `chat:write`, `chat:write.public`, `channels:read`, `groups:read` |
| Event Subscriptions | On. Request URL `$API_URL/api/v1/webhooks/slack/events`. Bot events: `app_uninstalled`, `tokens_revoked` |
| Manage Distribution | Enable public distribution if other Slack workspaces will install it |

Copy Client ID, Client Secret and Signing Secret into `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`. Token rotation is not supported yet, so leave it off.

## 4. First run in the UI

1. Sign in with GitHub.
2. Create a workspace (choose its timezone).
3. **Integrations → Install GitHub App**. Pick the organization and repositories on GitHub. You return to GitWhistle, which verifies you can access that installation and syncs repositories.
4. **Integrations → Add to Slack**, then **Add channels…** and **Send test**.
5. **Notification Rules → New rule** (or rely on fallback routing to the default channel).
6. **Settings**: enable the daily digest and reminder policies.
7. Open a PR in a monitored repository and watch Activity and Slack.

## 5. Docker Compose

```bash
cp backend/.env.example backend/.env    # fill in ENCRYPTION_KEY, GitHub and Slack values
# APP_URL/API_URL default to http://localhost:8080; export real public URLs before `up` when deploying
docker compose up --build
```

Services: `postgres`, `redis` (AOF, `noeviction`), `migrate` (one-shot), `api`, `worker`, and `web` (nginx serving the SPA and proxying `/api`) on `:8080`. Compose defaults to `NODE_ENV=production`, so GitHub and Slack settings are mandatory. For plain-HTTP local use in Safari, set `COOKIE_SECURE=false`. Chrome and Firefox accept secure cookies on `http://localhost`.

## 6. Deployment

- Build `backend/Dockerfile` once and run it as three workloads: API (`node src/server.js`, port 4000), worker (`node src/worker.js`, health 4001, `HEALTH_PORT=4001`), and a release-phase migration (`node src/database/migrate.js latest`).
- Build `client/Dockerfile` for the SPA, or serve `client/dist` from any static host that proxies `/api` to the API on the **same origin**.
- Terminate TLS in front of nginx or the load balancer and set `TRUST_PROXY` to the number of proxy hops.
- Use managed PostgreSQL (backups enabled) and Redis with persistence and `noeviction`.
- Scale the API horizontally freely. Workers can also scale horizontally: per-row locks and deterministic job ids make concurrent workers safe. Schedulers are upserted idempotently.
- Probes: liveness `/healthz`, readiness `/readyz`. Scrape `/metrics` with `METRICS_TOKEN`.

## 7. Tests

```bash
cd backend && npm test     # 90 tests: embedded PostgreSQL, fake GitHub/Slack/queues
cd backend && npm run lint
cd client && npm test && npm run lint && npm run build
```

Set `TEST_DATABASE_URL` to use an existing PostgreSQL instead of the embedded one (CI does this). Tests truncate tables, so never point it at real data.

## 8. Manual integration test with real accounts

Use a throwaway GitHub organization and Slack workspace.

1. Complete steps 2–4 above against a tunnel URL.
2. In GitHub → App settings → **Advanced → Recent deliveries**, confirm `installation` was delivered with **202**.
3. Open a PR into `main`, request a review, submit a review with "Request changes", and close an issue. Each should show up in **Activity**, and the matching Slack messages should arrive.
4. Re-deliver the PR webhook from GitHub's *Recent deliveries*. The response is **200** `duplicate: true` and no second Slack message appears.
5. Push a commit that makes a workflow fail. A `workflow_run.completed` notification arrives with a ✗, branch, commit and duration.
6. Stop the worker, open another PR, and start the worker again. The notification is delivered after restart.
7. Set the `review_pending` threshold to 1 hour, wait for the next 15-minute scan, and confirm exactly one reminder is sent.
8. **Settings → Send test digest**, then enable the digest with the current hour and confirm one digest per day.
9. Remove the Slack app from the Slack workspace. Integrations shows Slack as **revoked** and deliveries stop.
10. With a second GitHub user who is not a member, confirm `/w/<id>` shows nothing and the API returns 404.
