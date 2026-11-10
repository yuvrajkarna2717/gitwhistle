# Development progress

Status as of **10 November 2026**. "Verified" means an automated test or a live run exercised the actual code path. Anything that needs real GitHub or Slack accounts is listed separately as **not verified live**.

## How things were verified

- **Backend suite**: `cd backend && npm test`, **90 tests in 10 files, all passing**. Tests run against a real PostgreSQL 18 (`embedded-postgres`) with real migrations. GitHub, Slack and the queue producer are in-process fakes, plus a local HTTP fake of the GitHub REST API for the token and pagination tests.
- **Client suite**: `cd client && npm test`, **7 tests passing** (jsdom). `npm run build` succeeds. `eslint` is clean in both packages.
- **Live end-to-end run** (this machine, 10 Nov 2026): the real API process (`node src/server.js`) and worker process (`node src/worker.js`) ran against real PostgreSQL and a real Redis 8 server. Slack's Web API was replaced by a local HTTP mock reached through the real `@slack/web-api` client (`SLACK_API_URL`). Results:
  - Signed `installation.created` webhook → installation and repository rows were created by the worker.
  - Slack OAuth connect → callback → token exchange (mock) → encrypted token stored. Replaying the state was rejected.
  - Channel discovery and selection, and rule creation, via the REST API.
  - A forged webhook was rejected with 401. A signed `pull_request.opened` → 202 → worker → rule matched → `chat.postMessage` to `#backend` → delivery `sent` with a Slack `ts`.
  - Redelivering the same `X-GitHub-Delivery` → 200 `duplicate: true`. Still exactly one delivery.
  - Review, issue and failed-CI webhooks were delivered. The CI failure went to `#devops` with high priority. A Slack **429 with Retry-After** on one message was honoured via BullMQ `moveToDelayed` and delivered on the second attempt.
  - **Redis and worker stopped** → webhook still answered 202 in about 1.9 s and was stored `pending`. Redis restarted **empty**, worker restarted → the outbox relay re-enqueued the delivery and it was sent (`gitwhistle_outbox_requeued_total{kind="event"} 1`).
  - The scheduled daily digest was created once, `daily_digests` unique per day, and sent.
  - The production-mode install (`npm ci --omit=dev`, `NODE_ENV=production`) started, `/readyz` returned ready, and the login redirect set a `__Host-` `Secure` `HttpOnly` cookie. With Slack settings missing, startup was refused with a clear message.
  - Migrations ran `latest` → `down-all` → `latest` on a fresh database (the commands CI uses).
- **Not run here**: Docker builds and Docker Compose. Docker is not installed on this machine, so the images are built in CI instead. Real GitHub and Slack accounts were not used either.

---

## Phase 0: Recovery ✅

Every issue from the audit was reproduced and resolved:

| # | Issue | Resolution | Evidence |
|---|---|---|---|
| 1 | `GitHubApp.jsx` declared `availableRepos` twice, so the build failed | Prototype UI replaced by a routed SPA | `npm run build` passes |
| 2 | Webhook signatures not verified | `verifyGitHubSignature` on the raw body, constant-time | `unit.test.js`, `pipeline.test.js`, live 401 |
| 3 | `express.json()` destroyed the raw body | `express.raw` mounted on the webhook routes before the JSON parser | same |
| 4 | No auth or customer separation | Sessions, workspaces, RBAC, composite-FK tenancy | `auth.test.js`, `tenancy.test.js` |
| 5 | Installations not linked to users | Setup-URL claim with a `GET /user/installations` ownership proof | `github.test.js` |
| 6 | No Slack | Full Slack integration (Phase 3) | `slack.test.js`, live run |
| 7 | Marked processed before handling | Marked processed in the same transaction as the effects | `pipeline.test.js` |
| 8 | No retries | DB-tracked attempts, exponential backoff, dead-letter, reprocess | `pipeline.test.js` |
| 9 | 100 kB webhook limit | 25 MB default (`WEBHOOK_BODY_LIMIT`), 413 above it | `pipeline.test.js` (3 MB accepted) |
| 10 | Only 30 repos synced | `octokit.paginate`, removed repos marked | `github.test.js` (250 repos; 207 over real HTTP pagination) |
| 11 | `returning('id')` treated as a number | All inserts destructure row objects | `auth.test.js` first-login test |
| 12 | Docker `npm ci` without a lockfile | Lockfiles committed, multi-stage image | CI `docker` job |
| 13 | `.gitignore` excluded the lockfile | Fixed | |
| 14 | No tests or CI | 97 tests, GitHub Actions workflow | |
| — | **GitHub App private key committed to a public repo** | File untracked (`git rm --cached`), `keys/` and `*.pem` ignored, key loadable from env. **The key must still be rotated on GitHub.** | SECURITY.md |

Prototype tables are kept: the first migration renames them to `legacy_*` and copies prototype users (tested).

## Phase 1: Security and multi-tenancy ✅

- GitHub OAuth sign-in with server-side sessions: HTTP-only, SameSite=Lax, secure and `__Host-` in production, absolute and idle expiry, logout.
- OAuth state: hashed, single-use (atomic consume), browser-bound, session-bound for integration flows.
- CSRF synchronizer token plus Origin check.
- Workspaces with owner/admin/member roles, last-owner protection, single-use invitation links (optionally restricted to a GitHub login), and an audit log.
- Isolation: per-request membership check (404 for non-members), workspace-scoped queries, composite FKs.

## Phase 2: GitHub integration ✅ (live GitHub not verified)

- One GitHub App provides login, installation and webhooks. Install initiation, Setup-URL callback, ownership verification and workspace association.
- Installation lifecycle: `created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`, `installation_repositories` added/removed, and `repository` renamed/archived/transferred/deleted.
- Paginated repository sync. Private, archived and disabled flags. Monitoring toggles. Per-repo default channel.
- Installation tokens via `@octokit/auth-app` (cached; refreshed before expiry). Retry and throttling plugins handle rate limits.
- Permission and event-subscription gap detection, shown in the UI.
- Durable ingestion → outbox relay → idempotent processor → canonical events.
- Handlers for every event and action in the brief: PRs (opened, reopened, edited, synchronize, ready_for_review, converted_to_draft, closed→merged/closed, review_requested), reviews, issues (incl. assignee/label), issue comments, push (branch/tag, commits, create/delete/force), workflow_run/job completed, releases, deployments and deployment statuses.

## Phase 3: Slack integration ✅ (live Slack not verified)

- OAuth v2 install with state. Bot token encrypted with AES-256-GCM and never returned to the browser.
- Channel discovery (`conversations.list`, paginated), selection (re-validated server-side), enable/disable, test message.
- Block Kit renderers for PRs, reviews, issues, comments, pushes, workflow runs/jobs, releases and deployments, with escaping of user text.
- Delivery outbox with deterministic dedupe keys, rate-limit handling (Retry-After), transient vs permanent error classification, and revocation handling (API errors and Events API `app_uninstalled`/`tokens_revoked`). Disconnect revokes the token.

## Phase 4: Intelligence and automation ✅

- Declarative rule engine (15 fields, 12 operators, priority, all/any, stop, mute, fallback routing) with CRUD and a preview/trace API.
- PR and review state tracking with out-of-order protection, backfill and reconciliation from GitHub, and derived statuses (waiting for review/author, approved, stale).
- Reminder policies (review pending, changes requested, stale) with an authoritative GitHub re-check and state-fingerprint dedupe plus repeat cycles.
- Issue tracking (assignees, labels, unassigned detection; critical-label routing through rules).
- Daily digest per workspace timezone and hour, one per day, empty-day handling, test send and preview.

## Phase 5: Dashboard ✅

Overview, Activity (filters by type/repo/actor/period, pagination, event detail with delivery status, admin webhook-delivery log with reprocess), Repositories, Pull Requests, Issues, Notification Rules (builder + test against recent events), Integrations (GitHub/Slack connect, permission warnings, channels, test, disconnect), Settings (general, fallback routing, digest, reminder policies, members/roles/invitations, audit log, delete workspace), Workspace selection/creation, and invitation acceptance. Every page has loading, error (with retry), empty and success feedback, uses only live API data, and hides admin actions from members (the server enforces them independently).

## Phase 6: Production readiness ✅ (Docker not built locally)

Multi-stage, non-root backend image used for api/worker/migrate. nginx web image (same-origin proxy, 26 MB body, security headers). Compose stack with health-gated startup and a one-shot migration. GitHub Actions: lint, migration up/down/up, tests, `npm audit`, image builds and a no-secrets-in-image check. Structured logs with redaction, Prometheus metrics, `/healthz` and `/readyz` on both processes, graceful shutdown. Documentation set.

---

## Files

**Removed (prototype)**: `backend/src/{api/*,jobs/*,lib/*,middleware/auth.ts,server.ts,workers/worker.ts}`, `backend/knexfile.ts`, `backend/tsconfig.json`, `backend/docker-compose.yml` (replaced by the root compose file), `client/src/App.jsx`, `client/src/components/**`, `client/src/assets/react.svg`. `backend/keys/github_app.pem` was **untracked but left on disk**.

**Created**: everything under `backend/src` and `backend/test`, `backend/{eslint.config.js,vitest.config.js,.dockerignore,package-lock.json}`, `client/src/{app,components,features,hooks,layouts,services,test,utils}`, `client/{Dockerfile,nginx.conf,.dockerignore}`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.gitignore`, and the docs (`README.md`, `ARCHITECTURE.md`, `API_DOCUMENTATION.md`, `SETUP.md`, `ENVIRONMENT.md`, `SECURITY.md`, this file).

**Modified**: `backend/{package.json,.env.example,.gitignore,Dockerfile}`, `client/{package.json,package-lock.json,eslint.config.js,index.html,vite.config.js,README.md,src/main.jsx}`.

## Migrations (`backend/src/database/migrations`, table `gitwhistle_migrations`)

1. `20261110000001_core_identity_and_workspaces`: users, sessions, oauth_states, workspaces, workspace_members, workspace_invitations, audit_logs. Renames prototype tables to `legacy_*`.
2. `20261110000002_integrations_repositories_channels`: integrations, notification_channels, repositories, plus same-tenant channel FKs.
3. `20261110000003_event_ingestion`: webhook_deliveries (outbox), event_processing_attempts, events.
4. `20261110000004_notifications_and_tracking`: notification_rules, notification_deliveries, pull_requests, pull_request_reviews, issues, reminder_policies, daily_digests.

All have working `down` migrations (tested).

## Dependencies

- **Backend added**: `@octokit/plugin-retry`, `@octokit/plugin-throttling`, `@slack/web-api`, `zod`, `pino`, `pino-http`, `express-rate-limit`, `luxon`, `prom-client`. Dev: `vitest`, `supertest`, `embedded-postgres`, `@eslint/js`, `globals`, `pino-pretty`.
- **Backend removed**: `axios` (native fetch), `bcryptjs` and `jsonwebtoken` (no passwords or JWTs), `@octokit/app` (unused), `ts-node-dev` (unmaintained), `typescript` and `@types/*`, `prettier` (no config existed).
- **Kept**: express 5, helmet, cors, cookie-parser, dotenv, knex, pg, bullmq 5, ioredis 5 (aligned with BullMQ), `@octokit/rest`, `@octokit/auth-app`.
- **Client**: vite updated to 7.3.8 and react-router to a patched 7.x via `npm audit fix` (18 → 0 advisories). Dev added: `vitest`, `@testing-library/{react,jest-dom,user-event}`, `jsdom`.

## Known limitations

- Slack delivery is at-least-once. A crash in the send/commit window can duplicate one message.
- In-memory rate limiting per API process.
- No Slack message threading (each event is a top-level message). No Slack interactivity (buttons are links only).
- Reminders re-check at most 25 PRs per workspace per scan against GitHub. Backfill is capped at 200 open PRs (reviews fetched for the first 50) per repository.
- One Slack workspace and one GitHub installation per GitWhistle workspace is the intended model. Multiple GitHub installations per workspace work, but have only been tested lightly.
- No billing, no email notifications, no SSO.
- The frontend uses Tailwind (already in the project); Bootstrap was not introduced.

## Remaining work (suggested next steps)

1. **Rotate the leaked GitHub App key** (see SECURITY.md), then run the manual integration test in SETUP.md §8 against real accounts.
2. Run CI once on GitHub to confirm the Docker builds, then `docker compose up` locally.
3. Slack threading per PR (store the first message `ts` per PR and channel).
4. Redis-backed rate limiting for multi-replica deployments.
5. Data deletion and export tooling, plus key-rotation tooling for `ENCRYPTION_KEY`.
6. Then, by customer demand only: Microsoft Teams (destination adapter) or GitLab (source adapter).
