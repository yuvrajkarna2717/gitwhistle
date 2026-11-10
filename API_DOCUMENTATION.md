# GitWhistle API (v1)

Base path: `/api/v1`. JSON in and out.

## Conventions

- **Authentication**: an HTTP-only session cookie (`gw_session`, or `__Host-gw_session` when cookies are secure), set by the GitHub login callback. Tokens are never exposed to JavaScript.
- **CSRF**: every non-GET request from a signed-in browser must send `X-CSRF-Token: <csrfToken from GET /auth/me>`. Requests whose `Origin` header is not an allowed origin are rejected.
- **Success**: `{ "data": …, "meta"?: { "page", "pageSize", "total", "totalPages" } }`
- **Error**: `{ "error": { "code", "message", "details"? } }`. Common codes:

| Code | Meaning |
|---|---|
| 400 `bad_request` | Semantically invalid (e.g. a channel from another workspace) |
| 401 `unauthorized` | No or expired session |
| 403 `forbidden` | Missing role, bad CSRF token, or cross-origin |
| 404 `not_found` | Unknown resource, **or a workspace you are not a member of** |
| 409 `conflict` | E.g. removing the last owner |
| 413 `payload_too_large` | Body over the limit |
| 422 `validation_failed` | `details: [{ path, message }]` |
| 429 `rate_limited` | Too many requests |
| 503 `unavailable` | Integration not configured on the server |

- **Pagination**: `?page=1&pageSize=25` (maximum 100, or 200 for repositories).
- **Roles**: `member` (read), `admin` (configure integrations, repositories, rules, channels, settings, invitations), `owner` (admin + roles + delete workspace). In the tables below, "role" is the minimum required.

## Authentication

| Method | Path | Notes |
|---|---|---|
| GET | `/auth/github/login?returnTo=/path` | Redirects to GitHub. Sets a short-lived state-binding cookie. `returnTo` must be a relative path |
| GET | `/auth/github/callback` | GitHub redirect target, used for login **and** for installation-ownership verification. Redirects to the app |
| GET | `/auth/me` | `{ user, csrfToken, workspaces: [{ id, name, slug, role }] }` |
| POST | `/auth/logout` | Deletes the server-side session |

## Workspaces, members, invitations

| Method | Path | Role | Body / query |
|---|---|---|---|
| GET | `/workspaces` | signed in | |
| POST | `/workspaces` | signed in | `{ name (2–100), timezone? (IANA) }`. The creator becomes owner |
| GET | `/workspaces/:id` | member | |
| PATCH | `/workspaces/:id` | admin | `{ name?, timezone?, fallbackRoutingEnabled?, defaultChannelId?, digestEnabled?, digestHour? (0–23), digestChannelId? }` |
| DELETE | `/workspaces/:id` | owner | Deletes all workspace data |
| GET | `/workspaces/:id/members` | member | |
| PATCH | `/workspaces/:id/members/:userId` | owner | `{ role: owner\|admin\|member }`. The last owner cannot be demoted |
| DELETE | `/workspaces/:id/members/:userId` | admin (members) / owner (admins) / self | |
| GET | `/workspaces/:id/invitations` | admin | Pending invitations |
| POST | `/workspaces/:id/invitations` | admin | `{ role: admin\|member, githubLogin? }` → `{ url }` (shown once, single use, 7 days) |
| DELETE | `/workspaces/:id/invitations/:invitationId` | admin | Revoke |
| POST | `/invitations/preview` | signed in | `{ token }` → `{ workspaceName, role }` |
| POST | `/invitations/accept` | signed in | `{ token }` |
| GET | `/workspaces/:id/audit-logs` | admin | Paginated |

## Integrations

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/workspaces/:id/integrations` | member | `{ integrations, available: { github, slack }, requirements }`. Never includes credentials |
| GET | `/workspaces/:id/integrations/github/install` | admin | Redirects to the GitHub App installation page with state |
| GET | `/integrations/github/setup` | signed in | GitHub App **Setup URL**. Validates state, then starts the ownership-verification OAuth round trip |
| POST | `/workspaces/:id/integrations/:integrationId/sync` | admin | Queues a full repository sync (GitHub) |
| DELETE | `/workspaces/:id/integrations/:integrationId` | admin | Disconnect. Slack: revokes the token, wipes credentials, disables channels |
| GET | `/workspaces/:id/integrations/slack/connect` | admin | Redirects to Slack OAuth v2 with state |
| GET | `/integrations/slack/callback` | signed in (admin of the workspace in state) | Slack redirect URL |
| GET | `/workspaces/:id/integrations/slack/channels` | admin | Channels visible to the bot (`conversations.list`) |

## Channels and notification history

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/workspaces/:id/channels` | member | Configured destinations |
| POST | `/workspaces/:id/channels` | admin | `{ externalIds: ["C0123…"] }`. Ids are re-validated against Slack. The first channel becomes the workspace default |
| PATCH | `/workspaces/:id/channels/:channelId` | admin | `{ enabled }` |
| DELETE | `/workspaces/:id/channels/:channelId` | admin | |
| POST | `/workspaces/:id/channels/:channelId/test` | admin | Sends a test message through the real delivery path → `{ outcome }` |
| GET | `/workspaces/:id/notifications` | member | `?status=&kind=event\|reminder\|digest\|test&channelId=` |
| POST | `/workspaces/:id/notifications/:deliveryId/retry` | admin | Re-queue a failed, dead or skipped delivery |

## Repositories

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/workspaces/:id/repositories` | member | `?search=&monitored=true\|false&includeRemoved=true` |
| PATCH | `/workspaces/:id/repositories/:repositoryId` | admin | `{ monitoringEnabled?, defaultChannelId? }`. Enabling queues a PR/issue backfill |
| POST | `/workspaces/:id/repositories/:repositoryId/sync` | admin | Queue a backfill |

## Activity and webhook deliveries

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/workspaces/:id/events` | member | `?eventType=pull_request,issues.opened&repositoryId=&actor=&status=open\|closed\|merged\|success\|failure&from=ISO&to=ISO` |
| GET | `/workspaces/:id/events/types` | member | Distinct event types seen |
| GET | `/workspaces/:id/events/actors` | member | Distinct actors (last 90 days) |
| GET | `/workspaces/:id/events/:eventId` | member | Event + its notification deliveries |
| GET | `/workspaces/:id/webhook-deliveries` | admin | `?status=pending\|processing\|processed\|ignored\|failed\|dead` |
| POST | `/workspaces/:id/webhook-deliveries/:deliveryId/reprocess` | admin | Failed, dead or ignored deliveries with a payload still stored |

## Notification rules

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/workspaces/:id/notification-rules/meta` | member | Fields, operators and event types for builders |
| GET | `/workspaces/:id/notification-rules` | member | Ordered by priority |
| POST | `/workspaces/:id/notification-rules` | admin | Rule body (below) |
| PATCH | `/workspaces/:id/notification-rules/:ruleId` | admin | Partial rule |
| DELETE | `/workspaces/:id/notification-rules/:ruleId` | admin | |
| POST | `/workspaces/:id/notification-rules/preview` | member | `{ eventId }`: full routing decision with trace. `{ rule }`: matches against the last 100 events. Both: include a draft rule in the decision |

Rule body:

```json
{
  "name": "CI failures to #devops",
  "enabled": true,
  "priority": 10,
  "matchMode": "all",
  "conditions": [
    { "field": "eventType", "operator": "equals", "value": "workflow_run.completed" },
    { "field": "workflowConclusion", "operator": "equals", "value": "failure" },
    { "field": "branch", "operator": "matches", "value": "release/*" }
  ],
  "actions": { "channelIds": ["<channel uuid>"], "priority": "high", "stopProcessing": false, "suppress": false }
}
```

Fields: `eventType, repository, branch, headBranch, actor, author, prState, draft, reviewState, workflowName, workflowConclusion, labels, assignees, environment, deploymentState`.
Operators: strings `equals, not_equals, in, not_in, matches, not_matches, exists`. Booleans `equals, exists`. Arrays `contains, not_contains, contains_any, is_empty, is_not_empty`. Matching is case-insensitive.

Event types: `pull_request.{opened,reopened,edited,synchronize,ready_for_review,converted_to_draft,review_requested,merged,closed}`, `pull_request_review.{submitted,edited,dismissed}`, `issues.{opened,edited,assigned,unassigned,labeled,unlabeled,closed,reopened}`, `issue_comment.{created,edited,deleted}`, `push`, `workflow_run.completed`, `workflow_job.completed`, `release.{published,created,edited}`, `deployment.created`, `deployment_status.created`.

## Pull requests, issues, reminders, digests, overview

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/workspaces/:id/pull-requests` | member | `?status=open\|waiting_for_review\|waiting_for_author\|approved\|stale\|draft\|merged\|closed\|all&repositoryId=&author=` |
| GET | `/workspaces/:id/pull-requests/summary` | member | `{ open, waitingForReview, waitingForAuthor, draft, stale, staleHours }` |
| POST | `/workspaces/:id/pull-requests/:pullRequestId/refresh` | member | Re-read the PR and its reviews from GitHub |
| GET | `/workspaces/:id/issues` | member | `?state=open\|closed\|all&unassigned=true\|false&label=&assignee=&repositoryId=` |
| GET | `/workspaces/:id/issues/summary` | member | `{ open, unassigned }` |
| GET | `/workspaces/:id/reminder-policies` | member | `review_pending`, `changes_requested`, `stale_pr` |
| PUT | `/workspaces/:id/reminder-policies/:type` | admin | `{ enabled, thresholdHours (1–2160), repeatHours?, channelId? }` |
| GET | `/workspaces/:id/digests` | member | Last 30 daily digests |
| GET | `/workspaces/:id/digests/preview` | member | Summary for the last 24 h (nothing sent) |
| POST | `/workspaces/:id/digests/test` | admin | Send a one-off digest now |
| GET | `/workspaces/:id/overview` | member | Connection status, counts, recent events and notifications |

## Webhooks (machine-to-machine)

| Method | Path | Verification | Responses |
|---|---|---|---|
| POST | `/webhooks/github` | `X-Hub-Signature-256` HMAC over the raw body with `GITHUB_APP_WEBHOOK_SECRET` | 202 stored · 200 duplicate or ping · 401 bad signature · 400 bad headers or JSON · 413 over `WEBHOOK_BODY_LIMIT` (default 25 MB) |
| POST | `/webhooks/slack/events` | `X-Slack-Signature` v0 over `v0:{timestamp}:{body}`, timestamp within 5 minutes | `url_verification` challenge. Handles `app_uninstalled` and `tokens_revoked` |

## Operations (outside `/api`)

| Path | Notes |
|---|---|
| `GET /healthz` | Liveness |
| `GET /readyz` | 200 when PostgreSQL and Redis respond, else 503 |
| `GET /metrics` | Prometheus. Requires `Authorization: Bearer $METRICS_TOKEN`. Returns 404 if no token is configured |
