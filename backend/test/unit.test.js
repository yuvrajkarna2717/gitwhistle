import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, encryptJson, decryptJson, safeEqual } from '../src/shared/crypto.js';
import { verifyGitHubSignature, signGitHubPayload } from '../src/modules/github/signature.js';
import { verifySlackSignature, signSlackPayload } from '../src/modules/slack/signature.js';
import { normalizeGitHubEvent, missingPermissions } from '../src/modules/github/adapter.js';
import { renderEvent, renderDigest, esc } from '../src/modules/slack/blocks.js';
import { classifySlackError } from '../src/modules/slack/client.js';
import { computeReviewState } from '../src/modules/github/projections.js';
import { reminderCandidate, reminderDedupeKey } from '../src/modules/reminders/policies.js';
import { digestWindow } from '../src/modules/digests/digest.js';
import { DateTime } from 'luxon';
import { prPayload, workflowRunPayload, issuePayload } from './helpers.js';
import { loadConfig } from '../src/config/env.js';

const key = Buffer.alloc(32, 9);

describe('crypto', () => {
  it('round-trips AES-256-GCM and rejects tampering', () => {
    const c = encrypt('xoxb-secret', key);
    expect(c).not.toContain('xoxb');
    expect(decrypt(c, key)).toBe('xoxb-secret');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
    expect(decryptJson(encryptJson({ a: 1 }, key), key)).toEqual({ a: 1 });
    expect(() => decrypt(c, Buffer.alloc(32, 1))).toThrow();
  });
  it('safeEqual handles different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual(undefined, 'a')).toBe(false);
  });
});

describe('GitHub webhook signature', () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  it('accepts a correct signature over the raw bytes', () => {
    expect(verifyGitHubSignature('s3cret', body, signGitHubPayload('s3cret', body))).toBe(true);
  });
  it('rejects wrong secret, missing, malformed, and re-serialized bodies', () => {
    expect(verifyGitHubSignature('other', body, signGitHubPayload('s3cret', body))).toBe(false);
    expect(verifyGitHubSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyGitHubSignature('s3cret', body, 'sha256=abc')).toBe(false);
    expect(verifyGitHubSignature('s3cret', body, 'sha1=' + 'a'.repeat(40))).toBe(false);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyGitHubSignature('s3cret', reserialized, signGitHubPayload('s3cret', body))).toBe(false);
  });
});

describe('Slack request signature', () => {
  const body = Buffer.from('{"type":"url_verification","challenge":"x"}');
  it('accepts fresh valid signatures and rejects stale or forged ones', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifySlackSignature('sig', body, ts, signSlackPayload('sig', body, ts))).toBe(true);
    expect(verifySlackSignature('sig', body, ts, signSlackPayload('other', body, ts))).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(verifySlackSignature('sig', body, old, signSlackPayload('sig', body, old))).toBe(false);
    expect(verifySlackSignature('sig', body, ts, undefined)).toBe(false);
  });
});

describe('GitHub adapter normalization', () => {
  it('normalizes pull_request.opened with branch and reviewer data', () => {
    const e = normalizeGitHubEvent('pull_request', prPayload('opened'));
    expect(e.eventType).toBe('pull_request.opened');
    expect(e.repository).toEqual({ externalId: '1', fullName: 'acme/api' });
    expect(e.metadata).toMatchObject({ number: 42, baseBranch: 'main', headBranch: 'feature/auth', author: 'bob', state: 'open', requestedReviewers: ['carol'] });
    expect(e.resource).toMatchObject({ type: 'pull_request', number: 42 });
  });
  it('distinguishes merged from closed', () => {
    expect(normalizeGitHubEvent('pull_request', prPayload('closed', { pr: { state: 'closed', merged: true, merged_at: '2026-11-02T00:00:00Z' } })).eventType).toBe('pull_request.merged');
    expect(normalizeGitHubEvent('pull_request', prPayload('closed', { pr: { state: 'closed' } })).eventType).toBe('pull_request.closed');
  });
  it('normalizes workflow runs with duration and issues with assignee', () => {
    const w = normalizeGitHubEvent('workflow_run', workflowRunPayload('failure'));
    expect(w.metadata).toMatchObject({ conclusion: 'failure', workflowName: 'CI', branch: 'main', durationSeconds: 210, commitMessage: 'Fix tests' });
    const i = normalizeGitHubEvent('issues', issuePayload('assigned', { extra: { assignee: { login: 'erin' } }, issue: { assignees: [{ login: 'erin' }] } }));
    expect(i.metadata).toMatchObject({ assignee: 'erin', assignees: ['erin'], labels: ['bug'] });
  });
  it('ignores unsupported actions and events', () => {
    expect(normalizeGitHubEvent('pull_request', prPayload('locked'))).toBeNull();
    expect(normalizeGitHubEvent('star', { action: 'created' })).toBeNull();
    expect(normalizeGitHubEvent('workflow_run', { ...workflowRunPayload(), action: 'requested' })).toBeNull();
  });
  it('reports missing permissions', () => {
    expect(missingPermissions({ metadata: 'read', pull_requests: 'write' })).toEqual(['issues:read', 'contents:read', 'actions:read', 'deployments:read']);
  });
});

describe('Slack Block Kit rendering', () => {
  it('renders a PR with required fields and escapes user text', () => {
    const e = normalizeGitHubEvent('pull_request', prPayload('opened', { pr: { title: 'Fix <script> & stuff' } }));
    const msg = renderEvent(e);
    const json = JSON.stringify(msg.blocks);
    expect(json).toContain('acme/api');
    expect(json).toContain('#42');
    expect(json).toContain('bob');
    expect(json).toContain('feature/auth');
    expect(json).toContain('main');
    expect(json).toContain('https://github.com/acme/api/pull/42');
    expect(json).toContain('&lt;script&gt; &amp; stuff');
    expect(json).not.toContain('<script>');
    expect(msg.text.length).toBeGreaterThan(0);
  });
  it('renders workflow failures with status, branch, commit and duration', () => {
    const json = JSON.stringify(renderEvent(normalizeGitHubEvent('workflow_run', workflowRunPayload('failure'))).blocks);
    expect(json).toContain(':x:');
    expect(json).toContain('3m 30s');
    expect(json).toContain('deadbee');
    expect(json).toContain('actions/runs/777');
  });
  it('renders an empty digest gracefully', () => {
    const zero = { prsOpened: 0, prsMerged: 0, prsClosed: 0, reviewsSubmitted: 0, pendingReviews: 0, stalePrs: 0, issuesOpened: 0, issuesClosed: 0, unassignedIssues: 0, failedWorkflows: 0, releases: 0 };
    expect(JSON.stringify(renderDigest({ workspaceName: 'Acme', dateLabel: 'Mon', summary: zero }).blocks)).toContain('No GitHub activity');
  });
  it('escapes mrkdwn control characters', () => expect(esc('<@U1>&')).toBe('&lt;@U1&gt;&amp;'));
});

describe('Slack error classification', () => {
  it('maps rate limits, revocation, permanent and transient errors', () => {
    expect(classifySlackError({ code: 'slack_webapi_rate_limited_error', retryAfter: 7 })).toEqual({ kind: 'rate_limited', retryAfterMs: 7000 });
    expect(classifySlackError({ code: 'slack_webapi_platform_error', data: { error: 'token_revoked' } }).kind).toBe('revoked');
    expect(classifySlackError({ code: 'slack_webapi_platform_error', data: { error: 'channel_not_found' } }).kind).toBe('permanent');
    expect(classifySlackError({ code: 'slack_webapi_platform_error', data: { error: 'internal_error' } }).kind).toBe('retryable');
    expect(classifySlackError({ code: 'slack_webapi_request_error' }).kind).toBe('retryable');
  });
});

describe('review state and reminders', () => {
  it('uses the latest non-comment review per reviewer', () => {
    expect(computeReviewState([{ reviewer_login: 'a', state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01' }, { reviewer_login: 'a', state: 'APPROVED', submitted_at: '2026-01-02' }])).toBe('approved');
    expect(computeReviewState([{ reviewer_login: 'a', state: 'APPROVED', submitted_at: '2026-01-01' }, { reviewer_login: 'b', state: 'CHANGES_REQUESTED', submitted_at: '2026-01-02' }])).toBe('changes_requested');
    expect(computeReviewState([{ reviewer_login: 'a', state: 'COMMENTED', submitted_at: '2026-01-01' }])).toBe('commented');
    expect(computeReviewState([])).toBe('none');
  });
  it('builds stable dedupe keys that change with state or repeat cycle', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const pr = { state: 'open', draft: false, review_state: 'none', head_sha: 'a', requested_reviewers: ['carol'], requested_teams: [], gh_created_at: '2026-11-01T12:00:00Z' };
    const policy = { threshold_hours: 24, repeat_hours: 24 };
    const c1 = reminderCandidate('review_pending', pr, { now });
    expect(c1.waitingHours).toBe(48);
    const k1 = reminderDedupeKey('review_pending', 'pr1', c1, policy);
    expect(reminderDedupeKey('review_pending', 'pr1', reminderCandidate('review_pending', pr, { now: now + 3600_000 }), policy)).toBe(k1);
    expect(reminderDedupeKey('review_pending', 'pr1', reminderCandidate('review_pending', pr, { now: now + 25 * 3600_000 }), policy)).not.toBe(k1);
    expect(reminderDedupeKey('review_pending', 'pr1', reminderCandidate('review_pending', { ...pr, head_sha: 'b' }, { now }), policy)).not.toBe(k1);
    expect(reminderCandidate('review_pending', { ...pr, draft: true }, { now })).toBeNull();
    expect(reminderCandidate('changes_requested', { ...pr, review_state: 'changes_requested', last_review_at: '2026-11-02T00:00:00Z', last_commit_at: '2026-11-02T05:00:00Z' }, { now })).toBeNull();
  });
});

describe('digest window', () => {
  it('computes the local-day window in the workspace timezone', () => {
    const now = DateTime.fromISO('2026-11-10T04:00:00Z'); // 09:30 in Kolkata
    const w = digestWindow('Asia/Kolkata', 9, now);
    expect(w.due).toBe(true);
    expect(w.digestDate).toBe('2026-11-10');
    expect(w.windowEnd.toISOString()).toBe('2026-11-10T03:30:00.000Z');
    expect(w.windowStart.toISOString()).toBe('2026-11-09T03:30:00.000Z');
    // 23:00 on Nov 9 in New York: the Nov 9 digest is due (catch-up), not Nov 10's.
    expect(digestWindow('America/New_York', 9, now)).toMatchObject({ due: true, digestDate: '2026-11-09' });
    expect(digestWindow('America/New_York', 9, DateTime.fromISO('2026-11-10T12:00:00Z')).digestDate).toBe('2026-11-10');
    expect(digestWindow('America/Los_Angeles', 9, DateTime.fromISO('2026-11-10T15:00:00Z')).due).toBe(false); // 07:00 local
  });
});

describe('configuration validation', () => {
  it('rejects bad encryption keys and missing production settings', () => {
    expect(() => loadConfig({ ...process.env, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...process.env, NODE_ENV: 'production', SLACK_CLIENT_ID: '' })).toThrow(/SLACK/);
    expect(() => loadConfig({ ...process.env, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});
