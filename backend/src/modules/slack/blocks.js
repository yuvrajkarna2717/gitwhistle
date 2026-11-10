/**
 * Block Kit renderers for canonical events, reminders, and digests.
 * All user-controlled text is escaped; Slack mrkdwn treats &, <, > as control characters.
 */

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};
const link = (url, label) => (url && /^https?:\/\//.test(url) ? `<${url}|${esc(clip(label, 200))}>` : esc(clip(label, 200)));
const code = (s) => (s ? `\`${esc(clip(s, 80))}\`` : '—');

function duration(seconds) {
  if (seconds == null) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function fields(pairs) {
  const items = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').slice(0, 10);
  return items.length ? { type: 'section', fields: items.map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*\n${v}` })) } : null;
}

function button(url, text = 'View on GitHub') {
  if (!url || !/^https?:\/\//.test(url)) return null;
  return { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text, emoji: true }, url }] };
}

function context(event, priority) {
  const parts = [`${esc(event.repository?.fullName || '')}`];
  if (event.actor?.login) parts.push(`by *${esc(event.actor.login)}*`);
  if (priority === 'high') parts.push(':rotating_light: high priority');
  return { type: 'context', elements: [{ type: 'mrkdwn', text: parts.filter(Boolean).join(' · ') }] };
}

const PR_EMOJI = {
  opened: ':large_green_circle:',
  reopened: ':large_green_circle:',
  ready_for_review: ':eyes:',
  converted_to_draft: ':pencil2:',
  edited: ':pencil2:',
  synchronize: ':arrows_counterclockwise:',
  review_requested: ':eyes:',
  merged: ':purple_circle:',
  closed: ':red_circle:',
};

const REVIEW_EMOJI = { approved: ':white_check_mark:', changes_requested: ':x:', commented: ':speech_balloon:', dismissed: ':no_entry_sign:' };
const RUN_EMOJI = { success: ':white_check_mark:', failure: ':x:', timed_out: ':hourglass:', cancelled: ':no_entry_sign:', startup_failure: ':x:', action_required: ':warning:' };
const DEPLOY_EMOJI = { success: ':rocket:', failure: ':x:', error: ':x:', in_progress: ':hourglass_flowing_sand:', queued: ':hourglass:', pending: ':hourglass:', inactive: ':white_circle:' };

function wrap(text, blocks) {
  return { text: clip(text, 3000), blocks: blocks.filter(Boolean) };
}

/** Render a canonical event to a Slack message ({ text, blocks }). */
export function renderEvent(event, { priority = 'normal' } = {}) {
  const m = event.metadata || {};
  const repo = event.repository?.fullName || '';
  const [type, action] = event.eventType.split('.');

  if (type === 'pull_request') {
    const verb = action === 'merged' ? 'merged' : action === 'review_requested' ? 'review requested' : action.replace(/_/g, ' ');
    const status = m.state === 'merged' ? 'Merged' : m.draft ? 'Draft' : m.state === 'closed' ? 'Closed' : 'Open';
    const title = `${PR_EMOJI[action] || ':information_source:'} Pull request ${verb}: ${link(m.url, `#${m.number} ${m.title}`)}`;
    return wrap(`[${repo}] PR #${m.number} ${verb}: ${m.title}`, [
      { type: 'section', text: { type: 'mrkdwn', text: title } },
      fields([
        ['Repository', esc(repo)],
        ['Author', esc(m.author)],
        ['Branches', `${code(m.headBranch)} → ${code(m.baseBranch)}`],
        ['Status', status],
        action === 'review_requested' ? ['Reviewer', esc(m.requestedReviewer || m.requestedTeam)] : null,
        action === 'merged' && m.mergedBy ? ['Merged by', esc(m.mergedBy)] : null,
        m.additions != null ? ['Changes', `+${m.additions} / −${m.deletions ?? 0}`] : null,
      ].filter(Boolean)),
      context(event, priority),
      button(m.url),
    ]);
  }

  if (type === 'pull_request_review') {
    const state = m.reviewState || 'commented';
    const label = state.replace(/_/g, ' ');
    return wrap(`[${repo}] ${m.reviewer} ${label} PR #${m.number}: ${m.title}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `${REVIEW_EMOJI[state] || ':speech_balloon:'} *${esc(m.reviewer)}* ${esc(label)} ${link(m.url, `#${m.number} ${m.title}`)}` } },
      fields([
        ['Repository', esc(repo)],
        ['Reviewer', esc(m.reviewer)],
        ['Review', esc(label)],
        ['Author', esc(m.author)],
      ]),
      m.reviewExcerpt ? { type: 'section', text: { type: 'mrkdwn', text: `>${esc(clip(m.reviewExcerpt, 280)).replace(/\n/g, '\n>')}` } } : null,
      context(event, priority),
      button(m.reviewUrl || m.url, 'View review'),
    ]);
  }

  if (type === 'issues') {
    const emoji = action === 'closed' ? ':white_check_mark:' : action === 'opened' || action === 'reopened' ? ':large_orange_circle:' : ':label:';
    const verb = action === 'assigned' ? `assigned to ${m.assignee}` : action === 'unassigned' ? `unassigned from ${m.assignee}` : action === 'labeled' ? `labeled ${m.label}` : action;
    return wrap(`[${repo}] Issue #${m.number} ${verb}: ${m.title}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `${emoji} Issue ${esc(verb)}: ${link(m.url, `#${m.number} ${m.title}`)}` } },
      fields([
        ['Repository', esc(repo)],
        ['Author', esc(m.author)],
        ['Assignees', m.assignees?.length ? esc(m.assignees.join(', ')) : '_Unassigned_'],
        ['Labels', m.labels?.length ? m.labels.map((l) => code(l)).join(' ') : '—'],
        ['State', esc(m.state)],
      ]),
      context(event, priority),
      button(m.url),
    ]);
  }

  if (type === 'issue_comment') {
    const kind = m.isPullRequest ? 'PR' : 'issue';
    return wrap(`[${repo}] ${m.commentAuthor} commented on ${kind} #${m.number}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `:speech_balloon: *${esc(m.commentAuthor)}* ${esc(action)} a comment on ${kind} ${link(m.commentUrl || m.url, `#${m.number} ${m.title}`)}` } },
      m.excerpt ? { type: 'section', text: { type: 'mrkdwn', text: `>${esc(clip(m.excerpt, 280)).replace(/\n/g, '\n>')}` } } : null,
      context(event, priority),
      button(m.commentUrl || m.url, 'View comment'),
    ]);
  }

  if (type === 'push') {
    const what = m.deleted ? `deleted ${m.refType} ${code(m.branch)}` : m.created && !m.commitCount ? `created ${m.refType} ${code(m.branch)}` : `pushed ${m.commitCount} commit${m.commitCount === 1 ? '' : 's'} to ${code(m.branch)}`;
    const commitLines = (m.commits || []).map((c) => `• ${link(c.url?.replace('api.github.com/repos', 'github.com').replace('/commits/', '/commit/'), c.sha?.slice(0, 7))} ${esc(clip(c.message, 120))}`);
    return wrap(`[${repo}] ${event.actor?.login} ${what.replace(/`/g, '')}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `:arrow_up: *${esc(event.actor?.login)}* ${what}${m.forced ? ' (force-push)' : ''}` } },
      commitLines.length ? { type: 'section', text: { type: 'mrkdwn', text: commitLines.join('\n') } } : null,
      context(event, priority),
      button(m.compareUrl, 'Compare changes'),
    ]);
  }

  if (type === 'workflow_run' || type === 'workflow_job') {
    const conclusion = m.conclusion || 'unknown';
    const name = type === 'workflow_job' ? `${m.workflowName ? `${m.workflowName} / ` : ''}${m.jobName}` : m.workflowName;
    return wrap(`[${repo}] Workflow ${name} ${conclusion} on ${m.branch}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `${RUN_EMOJI[conclusion] || ':grey_question:'} Workflow ${link(m.url, name || 'run')} *${esc(conclusion.replace(/_/g, ' '))}*` } },
      fields([
        ['Repository', esc(repo)],
        ['Branch', code(m.branch)],
        ['Commit', m.headSha ? `${code(m.headSha.slice(0, 7))} ${esc(clip(m.commitMessage, 80))}` : null],
        ['Duration', duration(m.durationSeconds)],
        type === 'workflow_run' ? ['Run', `#${m.runNumber}${m.runAttempt > 1 ? ` (attempt ${m.runAttempt})` : ''}`] : null,
      ].filter(Boolean)),
      context(event, priority),
      button(m.url, 'View run'),
    ]);
  }

  if (type === 'release') {
    return wrap(`[${repo}] Release ${m.name} (${m.tag}) ${action}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `:package: Release ${esc(action)}: ${link(m.url, m.name)}${m.prerelease ? ' _(pre-release)_' : ''}` } },
      fields([
        ['Repository', esc(repo)],
        ['Tag', code(m.tag)],
        ['Author', esc(m.author)],
      ]),
      context(event, priority),
      button(m.url, 'View release'),
    ]);
  }

  if (type === 'deployment' || type === 'deployment_status') {
    const state = type === 'deployment' ? 'created' : m.state;
    return wrap(`[${repo}] Deployment to ${m.environment}: ${state}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `${DEPLOY_EMOJI[state] || ':rocket:'} Deployment to *${esc(m.environment)}*: *${esc(state)}*` } },
      fields([
        ['Repository', esc(repo)],
        ['Ref', code(m.ref)],
        ['Commit', m.sha ? code(m.sha.slice(0, 7)) : null],
        ['Details', m.description ? esc(m.description) : null],
      ]),
      context(event, priority),
      button(m.targetUrl, 'Open deployment'),
    ]);
  }

  return wrap(`[${repo}] ${event.eventType}`, [
    { type: 'section', text: { type: 'mrkdwn', text: `:information_source: ${esc(event.eventType)} ${link(event.resource?.url, event.resource?.title || '')}` } },
    context(event, priority),
  ]);
}

const REMINDER_TITLES = {
  review_pending: ':hourglass_flowing_sand: Pull request waiting for review',
  changes_requested: ':memo: Changes requested, waiting on the author',
  stale_pr: ':zzz: Stale pull request',
};

function age(hours) {
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function renderReminder({ type, pr, repoFullName, waitingHours }) {
  const reviewers = (pr.requested_reviewers || []).concat((pr.requested_teams || []).map((t) => `@${t}`));
  const who =
    type === 'changes_requested'
      ? `*${esc(pr.author_login)}*, a reviewer requested changes ${age(waitingHours)} ago.`
      : type === 'review_pending'
        ? reviewers.length
          ? `Waiting ${age(waitingHours)} for review from ${esc(reviewers.join(', '))}.`
          : `Waiting ${age(waitingHours)} for a review (no reviewers requested).`
        : `No activity for ${age(waitingHours)}.`;
  return wrap(`[${repoFullName}] Reminder: PR #${pr.number} ${pr.title}`, [
    { type: 'section', text: { type: 'mrkdwn', text: `${REMINDER_TITLES[type]}\n${link(pr.html_url, `#${pr.number} ${pr.title}`)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: who } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(repoFullName)} · by *${esc(pr.author_login)}* · ${code(pr.head_ref)} → ${code(pr.base_ref)}` }] },
    button(pr.html_url, 'Open pull request'),
  ]);
}

export function renderDigest({ workspaceName, dateLabel, summary }) {
  const s = summary;
  const total =
    s.prsOpened + s.prsMerged + s.prsClosed + s.reviewsSubmitted + s.issuesOpened + s.issuesClosed + s.failedWorkflows + s.releases;
  const line = (label, n) => `${label}: *${n}*`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Daily engineering digest · ${clip(dateLabel, 60)}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: esc(workspaceName) }] },
  ];
  if (total === 0 && s.pendingReviews === 0 && s.stalePrs === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ':sunny: No GitHub activity in monitored repositories during this period.' } });
  } else {
    blocks.push(
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Pull requests*\n${line('Opened', s.prsOpened)}\n${line('Merged', s.prsMerged)}\n${line('Closed unmerged', s.prsClosed)}` },
          { type: 'mrkdwn', text: `*Reviews*\n${line('Submitted', s.reviewsSubmitted)}\n${line('PRs awaiting review', s.pendingReviews)}\n${line('Stale PRs', s.stalePrs)}` },
          { type: 'mrkdwn', text: `*Issues*\n${line('Opened', s.issuesOpened)}\n${line('Closed', s.issuesClosed)}\n${line('Open & unassigned', s.unassignedIssues)}` },
          { type: 'mrkdwn', text: `*Delivery*\n${line('Failed workflow runs', s.failedWorkflows)}\n${line('Releases published', s.releases)}` },
        ],
      },
    );
    const attention = [];
    for (const w of s.failedWorkflowList || []) attention.push(`:x: ${link(w.url, `${w.workflowName} on ${w.branch}`)} · ${esc(w.repository)}`);
    for (const p of s.oldestPendingReviews || []) attention.push(`:hourglass: ${link(p.url, `#${p.number} ${p.title}`)} · ${esc(p.repository)} · waiting ${age(p.waitingHours)}`);
    if (attention.length) {
      blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `*Needs attention*\n${attention.slice(0, 10).join('\n')}` } });
    }
  }
  return wrap(`Daily engineering digest for ${workspaceName} (${dateLabel})`, blocks);
}
