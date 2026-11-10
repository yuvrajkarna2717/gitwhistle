/**
 * Deterministic notification rule evaluation over canonical events.
 *
 * Semantics:
 *  - Enabled rules are evaluated in ascending priority (1 runs first), ties broken by creation time, then id.
 *  - A matching rule contributes its channels. A matching rule with `suppress` mutes the event:
 *    nothing is sent by it or by any later rule.
 *  - `stopProcessing` ends evaluation after that rule matches.
 *  - Destination channels are de-duplicated; delivery priority is "high" if any matching rule says so.
 *  - If no rule matched, fallback routing applies to the default notable events only.
 */

/** Events that notify the fallback channel when no rule matched (avoids noise from edits/synchronize). */
export function isNotableByDefault(event) {
  const m = event.metadata || {};
  switch (event.eventType) {
    case 'pull_request.opened':
    case 'pull_request.reopened':
    case 'pull_request.ready_for_review':
    case 'pull_request.merged':
    case 'issues.opened':
    case 'issues.assigned':
    case 'release.published':
      return !(event.eventType === 'pull_request.opened' && m.draft);
    case 'pull_request_review.submitted':
      return m.reviewState === 'approved' || m.reviewState === 'changes_requested';
    case 'workflow_run.completed':
      return ['failure', 'timed_out', 'startup_failure'].includes(m.conclusion);
    case 'deployment_status.created':
      return ['failure', 'error'].includes(m.state);
    default:
      return false;
  }
}

/** Extracts a rule field's value from a canonical event. */
export function fieldValue(event, field) {
  const m = event.metadata || {};
  switch (field) {
    case 'eventType':
      return event.eventType;
    case 'repository':
      return event.repository?.fullName ?? null;
    case 'branch':
      return m.baseBranch ?? m.branch ?? null;
    case 'headBranch':
      return m.headBranch ?? null;
    case 'actor':
      return event.actor?.login ?? null;
    case 'author':
      return m.author ?? null;
    case 'prState':
      return event.resource?.type === 'pull_request' ? (m.state ?? null) : null;
    case 'draft':
      return typeof m.draft === 'boolean' && event.resource?.type === 'pull_request' ? m.draft : null;
    case 'reviewState':
      return m.reviewState ?? null;
    case 'workflowName':
      return m.workflowName ?? null;
    case 'workflowConclusion':
      return m.conclusion ?? null;
    case 'labels':
      return Array.isArray(m.labels) ? m.labels : [];
    case 'assignees': {
      const list = Array.isArray(m.assignees) ? [...m.assignees] : [];
      if (m.assignee && !list.includes(m.assignee)) list.push(m.assignee);
      return list;
    }
    case 'environment':
      return m.environment ?? null;
    case 'deploymentState':
      return event.eventType === 'deployment_status.created' ? (m.state ?? null) : null;
    default:
      return null;
  }
}

const globCache = new Map();
/** Glob with * and ? only; everything else is matched literally. Case-insensitive. */
export function globToRegExp(glob) {
  let re = globCache.get(glob);
  if (!re) {
    const body = glob
      .split('')
      .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&')))
      .join('');
    re = new RegExp(`^${body}$`, 'i');
    if (globCache.size > 1000) globCache.clear();
    globCache.set(glob, re);
  }
  return re;
}

const norm = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

export function evaluateCondition(event, condition) {
  const actual = fieldValue(event, condition.field);
  const expected = condition.value;
  switch (condition.operator) {
    case 'equals':
      return actual !== null && actual !== undefined && norm(actual) === norm(expected);
    case 'not_equals':
      return norm(actual) !== norm(expected);
    case 'in':
      return actual != null && expected.map(norm).includes(norm(actual));
    case 'not_in':
      return actual == null || !expected.map(norm).includes(norm(actual));
    case 'matches':
      return typeof actual === 'string' && globToRegExp(expected).test(actual);
    case 'not_matches':
      return typeof actual !== 'string' || !globToRegExp(expected).test(actual);
    case 'exists':
      return actual !== null && actual !== undefined && actual !== '';
    case 'contains':
      return Array.isArray(actual) && actual.map(norm).includes(norm(expected));
    case 'not_contains':
      return !Array.isArray(actual) || !actual.map(norm).includes(norm(expected));
    case 'contains_any':
      return Array.isArray(actual) && expected.some((e) => actual.map(norm).includes(norm(e)));
    case 'is_empty':
      return !Array.isArray(actual) || actual.length === 0;
    case 'is_not_empty':
      return Array.isArray(actual) && actual.length > 0;
    default:
      return false;
  }
}

export function ruleMatches(event, rule) {
  const conditions = rule.conditions || [];
  if (conditions.length === 0) return true;
  return rule.matchMode === 'any'
    ? conditions.some((c) => evaluateCondition(event, c))
    : conditions.every((c) => evaluateCondition(event, c));
}

export function sortRules(rules) {
  return [...rules].sort(
    (a, b) =>
      a.priority - b.priority ||
      new Date(a.createdAt || 0) - new Date(b.createdAt || 0) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/**
 * @param event canonical event
 * @param rules [{ id, enabled, priority, matchMode, conditions, actions, createdAt }]
 * @param fallback { enabled, channelId }  repository default channel already resolved by caller
 * @param activeChannelIds Set of channel ids that are enabled and deliverable
 * @returns { channels: [{ channelId, ruleIds }], priority, matchedRuleIds, suppressed, usedFallback, trace }
 */
export function evaluateRules(event, rules, { fallback = { enabled: false, channelId: null }, activeChannelIds = null } = {}) {
  const trace = [];
  const destinations = new Map();
  const matched = [];
  let priority = 'normal';
  let suppressed = false;

  for (const rule of sortRules(rules.filter((r) => r.enabled))) {
    const isMatch = ruleMatches(event, rule);
    trace.push({ ruleId: rule.id, name: rule.name, matched: isMatch });
    if (!isMatch) continue;
    matched.push(rule.id);
    if (rule.actions.suppress) {
      suppressed = true;
      break;
    }
    if (rule.actions.priority === 'high') priority = 'high';
    for (const channelId of rule.actions.channelIds || []) {
      if (activeChannelIds && !activeChannelIds.has(channelId)) continue;
      if (!destinations.has(channelId)) destinations.set(channelId, []);
      destinations.get(channelId).push(rule.id);
    }
    if (rule.actions.stopProcessing) break;
  }

  let usedFallback = false;
  if (!suppressed && matched.length === 0 && fallback.enabled && fallback.channelId && isNotableByDefault(event)) {
    if (!activeChannelIds || activeChannelIds.has(fallback.channelId)) {
      destinations.set(fallback.channelId, []);
      usedFallback = true;
    }
  }

  return {
    channels: suppressed ? [] : [...destinations.entries()].map(([channelId, ruleIds]) => ({ channelId, ruleIds })),
    priority,
    matchedRuleIds: matched,
    suppressed,
    usedFallback,
    trace,
  };
}
