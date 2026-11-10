/**
 * GitHub source adapter: turns raw GitHub webhook payloads into canonical, provider-neutral events.
 * Nothing outside src/modules/github reads raw GitHub payload shapes for notification purposes.
 */

export const SUPPORTED_ACTIONS = {
  pull_request: ['opened', 'reopened', 'edited', 'synchronize', 'ready_for_review', 'converted_to_draft', 'closed', 'review_requested'],
  pull_request_review: ['submitted', 'edited', 'dismissed'],
  issues: ['opened', 'edited', 'assigned', 'unassigned', 'labeled', 'unlabeled', 'closed', 'reopened'],
  issue_comment: ['created', 'edited', 'deleted'],
  push: [null],
  workflow_run: ['completed'],
  workflow_job: ['completed'],
  release: ['published', 'created', 'edited'],
  deployment: ['created'],
  deployment_status: ['created'],
};

/** Events handled for lifecycle/state only (never produce canonical events). */
export const LIFECYCLE_EVENTS = new Set(['installation', 'installation_repositories', 'repository', 'ping', 'github_app_authorization']);

/** Webhook events the GitHub App must subscribe to. */
export const REQUIRED_EVENT_SUBSCRIPTIONS = [
  'pull_request',
  'pull_request_review',
  'issues',
  'issue_comment',
  'push',
  'workflow_run',
  'workflow_job',
  'release',
  'deployment',
  'deployment_status',
  'repository',
];

/** Minimum permissions for implemented features (all read-only). */
export const REQUIRED_PERMISSIONS = {
  metadata: 'read',
  pull_requests: 'read',
  issues: 'read',
  contents: 'read', // push and release events
  actions: 'read', // workflow_run / workflow_job
  deployments: 'read',
};

const LEVEL = { read: 1, write: 2, admin: 3 };

export function missingPermissions(granted = {}) {
  return Object.entries(REQUIRED_PERMISSIONS)
    .filter(([name, level]) => (LEVEL[granted[name]] || 0) < LEVEL[level])
    .map(([name, level]) => `${name}:${level}`);
}

export function isSupported(eventName, action) {
  const actions = SUPPORTED_ACTIONS[eventName];
  if (!actions) return false;
  return actions.includes(action ?? null) || (actions[0] === null && action == null);
}

const trimText = (s, n = 280) => (typeof s === 'string' && s.length ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null);
const firstLine = (s) => (typeof s === 'string' ? s.split('\n')[0].slice(0, 200) : '');
const logins = (arr) => (Array.isArray(arr) ? arr.map((u) => u?.login).filter(Boolean) : []);
const labelNames = (arr) => (Array.isArray(arr) ? arr.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : []);
const iso = (v, fallback) => (v ? new Date(v).toISOString() : fallback);

function prState(pr) {
  if (pr.merged || pr.merged_at) return 'merged';
  return pr.state;
}

function prMetadata(pr) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login ?? null,
    baseBranch: pr.base?.ref ?? null,
    headBranch: pr.head?.ref ?? null,
    headSha: pr.head?.sha ?? null,
    state: prState(pr),
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged || pr.merged_at),
    mergedBy: pr.merged_by?.login ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changedFiles: pr.changed_files ?? null,
    labels: labelNames(pr.labels),
    requestedReviewers: logins(pr.requested_reviewers),
  };
}

function base(eventType, payload, receivedAt) {
  return {
    source: 'github',
    eventType,
    actor: { login: payload.sender?.login ?? null, externalId: payload.sender?.id != null ? String(payload.sender.id) : null },
    repository: payload.repository
      ? { externalId: String(payload.repository.id), fullName: payload.repository.full_name }
      : null,
    occurredAt: receivedAt,
    receivedAt,
  };
}

/**
 * @returns canonical event object or null when the delivery is not something we model.
 */
export function normalizeGitHubEvent(eventName, payload, { receivedAt = new Date().toISOString() } = {}) {
  const action = payload.action ?? null;
  if (!isSupported(eventName, action)) return null;

  switch (eventName) {
    case 'pull_request': {
      const pr = payload.pull_request;
      let type = `pull_request.${action}`;
      if (action === 'closed') type = pr.merged ? 'pull_request.merged' : 'pull_request.closed';
      const metadata = { action, ...prMetadata(pr) };
      if (action === 'review_requested') {
        metadata.requestedReviewer = payload.requested_reviewer?.login ?? null;
        metadata.requestedTeam = payload.requested_team?.name ?? null;
      }
      return {
        ...base(type, payload, receivedAt),
        resource: { type: 'pull_request', externalId: String(pr.id), number: pr.number, title: pr.title, url: pr.html_url },
        metadata,
        occurredAt: iso(action === 'closed' ? pr.closed_at : pr.updated_at, receivedAt),
      };
    }
    case 'pull_request_review': {
      const pr = payload.pull_request;
      const review = payload.review;
      const reviewState = action === 'dismissed' ? 'dismissed' : String(review.state || '').toLowerCase();
      return {
        ...base(`pull_request_review.${action}`, payload, receivedAt),
        resource: { type: 'pull_request', externalId: String(pr.id), number: pr.number, title: pr.title, url: pr.html_url },
        metadata: {
          action,
          ...prMetadata(pr),
          reviewer: review.user?.login ?? null,
          reviewState,
          reviewUrl: review.html_url ?? pr.html_url,
          reviewExcerpt: trimText(review.body),
        },
        occurredAt: iso(review.submitted_at, receivedAt),
      };
    }
    case 'issues': {
      const issue = payload.issue;
      return {
        ...base(`issues.${action}`, payload, receivedAt),
        resource: { type: 'issue', externalId: String(issue.id), number: issue.number, title: issue.title, url: issue.html_url },
        metadata: {
          action,
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          author: issue.user?.login ?? null,
          state: issue.state,
          stateReason: issue.state_reason ?? null,
          labels: labelNames(issue.labels),
          assignees: logins(issue.assignees),
          assignee: payload.assignee?.login ?? null,
          label: payload.label?.name ?? null,
        },
        occurredAt: iso(issue.updated_at, receivedAt),
      };
    }
    case 'issue_comment': {
      const issue = payload.issue;
      const comment = payload.comment;
      const isPr = Boolean(issue.pull_request);
      return {
        ...base(`issue_comment.${action}`, payload, receivedAt),
        resource: {
          type: isPr ? 'pull_request' : 'issue',
          externalId: String(issue.id),
          number: issue.number,
          title: issue.title,
          url: comment.html_url ?? issue.html_url,
        },
        metadata: {
          action,
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          isPullRequest: isPr,
          commentUrl: comment.html_url,
          commentAuthor: comment.user?.login ?? null,
          excerpt: action === 'deleted' ? null : trimText(comment.body),
          labels: labelNames(issue.labels),
          assignees: logins(issue.assignees),
        },
        occurredAt: iso(comment.updated_at || comment.created_at, receivedAt),
      };
    }
    case 'push': {
      const ref = payload.ref || '';
      const refType = ref.startsWith('refs/tags/') ? 'tag' : 'branch';
      const branch = ref.replace(/^refs\/(heads|tags)\//, '');
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      return {
        ...base('push', payload, receivedAt),
        actor: { login: payload.sender?.login ?? payload.pusher?.name ?? null, externalId: payload.sender?.id != null ? String(payload.sender.id) : null },
        resource: { type: 'ref', externalId: ref, number: null, title: branch, url: payload.compare ?? null },
        metadata: {
          ref,
          refType,
          branch,
          before: payload.before,
          after: payload.after,
          created: Boolean(payload.created),
          deleted: Boolean(payload.deleted),
          forced: Boolean(payload.forced),
          compareUrl: payload.compare ?? null,
          commitCount: commits.length,
          defaultBranch: payload.repository?.default_branch ?? null,
          commits: commits.slice(0, 5).map((c) => ({
            sha: c.id,
            message: firstLine(c.message),
            author: c.author?.username || c.author?.name || null,
            url: c.url,
          })),
        },
        occurredAt: iso(payload.head_commit?.timestamp, receivedAt),
      };
    }
    case 'workflow_run': {
      const run = payload.workflow_run;
      const started = run.run_started_at ? new Date(run.run_started_at).getTime() : null;
      const ended = run.updated_at ? new Date(run.updated_at).getTime() : null;
      return {
        ...base(`workflow_run.${action}`, payload, receivedAt),
        resource: { type: 'workflow_run', externalId: String(run.id), number: run.run_number, title: run.name, url: run.html_url },
        metadata: {
          action,
          workflowName: run.name ?? payload.workflow?.name ?? null,
          runNumber: run.run_number,
          runAttempt: run.run_attempt ?? 1,
          status: run.status,
          conclusion: run.conclusion,
          branch: run.head_branch,
          headSha: run.head_sha,
          commitMessage: firstLine(run.head_commit?.message),
          triggerEvent: run.event,
          url: run.html_url,
          durationSeconds: started && ended && ended >= started ? Math.round((ended - started) / 1000) : null,
        },
        occurredAt: iso(run.updated_at, receivedAt),
      };
    }
    case 'workflow_job': {
      const job = payload.workflow_job;
      const started = job.started_at ? new Date(job.started_at).getTime() : null;
      const ended = job.completed_at ? new Date(job.completed_at).getTime() : null;
      return {
        ...base(`workflow_job.${action}`, payload, receivedAt),
        resource: { type: 'workflow_job', externalId: String(job.id), number: null, title: job.name, url: job.html_url },
        metadata: {
          action,
          jobName: job.name,
          workflowName: job.workflow_name ?? null,
          runId: job.run_id,
          conclusion: job.conclusion,
          branch: job.head_branch ?? null,
          headSha: job.head_sha,
          url: job.html_url,
          durationSeconds: started && ended && ended >= started ? Math.round((ended - started) / 1000) : null,
        },
        occurredAt: iso(job.completed_at, receivedAt),
      };
    }
    case 'release': {
      const rel = payload.release;
      return {
        ...base(`release.${action}`, payload, receivedAt),
        resource: { type: 'release', externalId: String(rel.id), number: null, title: rel.name || rel.tag_name, url: rel.html_url },
        metadata: {
          action,
          name: rel.name || rel.tag_name,
          tag: rel.tag_name,
          url: rel.html_url,
          author: rel.author?.login ?? null,
          prerelease: Boolean(rel.prerelease),
          draft: Boolean(rel.draft),
          branch: rel.target_commitish ?? null,
        },
        occurredAt: iso(rel.published_at || rel.created_at, receivedAt),
      };
    }
    case 'deployment': {
      const d = payload.deployment;
      return {
        ...base('deployment.created', payload, receivedAt),
        resource: { type: 'deployment', externalId: String(d.id), number: null, title: d.environment, url: d.url ?? null },
        metadata: { action, environment: d.environment, ref: d.ref, branch: d.ref, sha: d.sha, creator: d.creator?.login ?? null, description: trimText(d.description) },
        occurredAt: iso(d.created_at, receivedAt),
      };
    }
    case 'deployment_status': {
      const s = payload.deployment_status;
      const d = payload.deployment;
      return {
        ...base('deployment_status.created', payload, receivedAt),
        resource: { type: 'deployment', externalId: String(d.id), number: null, title: d.environment, url: s.target_url || s.log_url || null },
        metadata: {
          action,
          state: s.state,
          environment: s.environment || d.environment,
          ref: d.ref,
          branch: d.ref,
          sha: d.sha,
          description: trimText(s.description),
          targetUrl: s.target_url || s.environment_url || null,
        },
        occurredAt: iso(s.created_at, receivedAt),
      };
    }
    default:
      return null;
  }
}
