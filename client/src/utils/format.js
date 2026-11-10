export function timeAgo(value) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatHours(hours) {
  if (hours == null) return '—';
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const EVENT_LABELS = {
  'pull_request.opened': 'PR opened',
  'pull_request.reopened': 'PR reopened',
  'pull_request.edited': 'PR edited',
  'pull_request.synchronize': 'PR updated',
  'pull_request.ready_for_review': 'PR ready for review',
  'pull_request.converted_to_draft': 'PR converted to draft',
  'pull_request.review_requested': 'Review requested',
  'pull_request.merged': 'PR merged',
  'pull_request.closed': 'PR closed',
  'pull_request_review.submitted': 'Review submitted',
  'pull_request_review.edited': 'Review edited',
  'pull_request_review.dismissed': 'Review dismissed',
  'issues.opened': 'Issue opened',
  'issues.edited': 'Issue edited',
  'issues.assigned': 'Issue assigned',
  'issues.unassigned': 'Issue unassigned',
  'issues.labeled': 'Issue labeled',
  'issues.unlabeled': 'Issue unlabeled',
  'issues.closed': 'Issue closed',
  'issues.reopened': 'Issue reopened',
  'issue_comment.created': 'Comment added',
  'issue_comment.edited': 'Comment edited',
  'issue_comment.deleted': 'Comment deleted',
  push: 'Push',
  'workflow_run.completed': 'Workflow run',
  'workflow_job.completed': 'Workflow job',
  'release.published': 'Release published',
  'release.created': 'Release created',
  'release.edited': 'Release edited',
  'deployment.created': 'Deployment',
  'deployment_status.created': 'Deployment status',
};

export const eventLabel = (type) => EVENT_LABELS[type] || type;

/** One-line human summary of a canonical event. */
export function eventSummary(e) {
  const m = e.metadata || {};
  switch (e.eventType.split('.')[0]) {
    case 'pull_request':
      return `#${m.number} ${m.title}`;
    case 'pull_request_review':
      return `${m.reviewer} ${String(m.reviewState || '').replace('_', ' ')} #${m.number} ${m.title}`;
    case 'issues':
      return `#${m.number} ${m.title}${m.assignee ? ` → ${m.assignee}` : ''}`;
    case 'issue_comment':
      return `${m.commentAuthor} on #${m.number} ${m.title}`;
    case 'push':
      return m.deleted ? `deleted ${m.branch}` : `${m.commitCount} commit${m.commitCount === 1 ? '' : 's'} to ${m.branch}`;
    case 'workflow_run':
    case 'workflow_job':
      return `${m.workflowName || m.jobName} ${m.conclusion} on ${m.branch}`;
    case 'release':
      return `${m.name} (${m.tag})`;
    case 'deployment':
    case 'deployment_status':
      return `${m.environment}${m.state ? `: ${m.state}` : ''}`;
    default:
      return e.resource?.title || '';
  }
}

export function eventTone(e) {
  const m = e.metadata || {};
  if (['failure', 'timed_out', 'startup_failure'].includes(m.conclusion) || ['failure', 'error'].includes(m.state)) return 'red';
  if (e.eventType === 'pull_request.merged' || m.conclusion === 'success' || m.reviewState === 'approved') return 'green';
  if (m.reviewState === 'changes_requested') return 'amber';
  return 'slate';
}

export const PR_STATUS_LABEL = {
  waiting_for_review: 'Waiting for review',
  waiting_for_author: 'Waiting for author',
  approved: 'Approved',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

export const PR_STATUS_TONE = {
  waiting_for_review: 'amber',
  waiting_for_author: 'blue',
  approved: 'green',
  draft: 'slate',
  merged: 'violet',
  closed: 'red',
};
