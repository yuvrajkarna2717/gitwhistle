import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DateTime } from 'luxon';
import { buildApp, resetDb, testDb, seedConnectedWorkspace, sendWebhook, prPayload, prObject, workflowRunPayload, issuePayload, authed } from './helpers.js';
import { processWebhookDelivery } from '../src/modules/events/processor.js';
import { sendDelivery } from '../src/modules/notifications/deliveries.js';
import { runReminderScan } from '../src/modules/reminders/scanner.js';
import { runDigestScan, buildDigestSummary } from '../src/modules/digests/digest.js';

async function process(deps) {
  for (const id of deps.queues.events.splice(0)) await processWebhookDelivery(deps, id);
  deps.queues.deliveries.length = 0;
}

const HOUR = 3_600_000;

describe('PR review reminders', () => {
  beforeEach(resetDb);

  async function setup({ createdHoursAgo = 30 } = {}) {
    const ctx = buildApp();
    const s = await seedConnectedWorkspace(ctx.deps.config);
    const created = new Date(Date.now() - createdHoursAgo * HOUR).toISOString();
    await sendWebhook(ctx.app, ctx.deps.config, 'pull_request', prPayload('opened', { pr: { created_at: created, updated_at: created } }));
    await process(ctx.deps);
    await testDb()('pull_requests').update({ review_requested_at: created });
    await testDb()('reminder_policies').where({ workspace_id: s.ws.id, type: 'review_pending' }).update({ enabled: true, threshold_hours: 24, repeat_hours: 24 });
    // GitHub (authoritative) agrees the PR is still open and unreviewed.
    ctx.deps.github.getPullRequest = vi.fn(async () => prObject({ created_at: created, updated_at: created }));
    ctx.deps.github.listPullRequestReviews = vi.fn(async () => []);
    return { ...ctx, s };
  }

  it('sends one reminder for a PR waiting longer than the threshold, confirmed against GitHub', async () => {
    const { deps, s } = await setup();
    expect(await runReminderScan(deps)).toEqual({ created: 1 });
    expect(deps.github.getPullRequest).toHaveBeenCalledWith('555', 'acme', 'api', 42);
    const d = await testDb()('notification_deliveries').where({ kind: 'reminder' }).first();
    expect(d.channel_id).toBe(s.channel.id);
    expect(d.message.text).toContain('Reminder: PR #42');
    await sendDelivery(deps, d.id);
    expect(deps.slack.postMessage).toHaveBeenCalledOnce();

    // Re-scanning without a state change creates nothing new.
    expect(await runReminderScan(deps)).toEqual({ created: 0 });
    expect(await runReminderScan(deps, { now: Date.now() + 2 * HOUR })).toEqual({ created: 0 });
    // After the repeat interval, a follow-up is allowed.
    expect(await runReminderScan(deps, { now: Date.now() + 25 * HOUR })).toEqual({ created: 1 });
  });

  it('does not remind when GitHub shows the PR was already reviewed or merged', async () => {
    const { deps } = await setup();
    deps.github.listPullRequestReviews = vi.fn(async () => [{ id: 9, user: { login: 'carol' }, state: 'APPROVED', submitted_at: new Date().toISOString() }]);
    expect(await runReminderScan(deps)).toEqual({ created: 0 });
    expect((await testDb()('pull_requests').first()).review_state).toBe('approved');
  });

  it('does not remind before the threshold or for disabled policies', async () => {
    const early = await setup({ createdHoursAgo: 5 });
    expect(await runReminderScan(early.deps)).toEqual({ created: 0 });
    await resetDb();
    const off = await setup();
    await testDb()('reminder_policies').update({ enabled: false });
    expect(await runReminderScan(off.deps)).toEqual({ created: 0 });
  });

  it('skips the cycle if GitHub cannot be reached rather than reminding on stale data', async () => {
    const { deps } = await setup();
    deps.github.getPullRequest = vi.fn(async () => {
      throw Object.assign(new Error('bad gateway'), { status: 502 });
    });
    expect(await runReminderScan(deps)).toEqual({ created: 0 });
  });

  it('lists PRs waiting for review / author in the dashboard API', async () => {
    const { app, s } = await setup();
    const res = await authed(app, s.session).get(`/api/v1/workspaces/${s.ws.id}/pull-requests?status=waiting_for_review`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ number: 42, status: 'waiting_for_review', requestedReviewers: ['carol'] });
    const summary = await authed(app, s.session).get(`/api/v1/workspaces/${s.ws.id}/pull-requests/summary`);
    expect(summary.body.data).toMatchObject({ open: 1, waitingForReview: 1, waitingForAuthor: 0 });
  });
});

describe('daily digest', () => {
  beforeEach(resetDb);

  it('aggregates activity accurately from stored events and current PR/issue state', async () => {
    const { app, deps } = buildApp();
    const s = await seedConnectedWorkspace(deps.config);
    const at = (h) => new Date(Date.now() - h * HOUR).toISOString();
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened', { pr: { updated_at: at(5), created_at: at(5) } }));
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened', { pr: { id: 2, number: 43, updated_at: at(4), created_at: at(4) } }));
    await sendWebhook(app, deps.config, 'pull_request', prPayload('closed', { pr: { id: 2, number: 43, state: 'closed', merged: true, merged_at: at(3), closed_at: at(3), updated_at: at(3) } }));
    await sendWebhook(app, deps.config, 'issues', issuePayload('opened', { issue: { updated_at: at(2) } }));
    await sendWebhook(app, deps.config, 'workflow_run', { ...workflowRunPayload('failure'), workflow_run: { ...workflowRunPayload('failure').workflow_run, updated_at: at(1) } });
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened', { pr: { id: 3, number: 44, updated_at: at(30), created_at: at(30) } })); // outside window
    await process(deps);

    const windowEnd = new Date();
    const summary = await buildDigestSummary(testDb(), s.ws.id, { windowStart: new Date(windowEnd - 24 * HOUR), windowEnd });
    expect(summary).toMatchObject({ prsOpened: 2, prsMerged: 1, prsClosed: 0, issuesOpened: 1, failedWorkflows: 1, pendingReviews: 2, unassignedIssues: 1, releases: 0 });
    expect(summary.failedWorkflowList[0]).toMatchObject({ workflowName: 'CI', branch: 'main', repository: 'acme/api' });
  });

  it('sends at most one digest per workspace per local day, at the configured hour', async () => {
    const { deps } = buildApp();
    const s = await seedConnectedWorkspace(deps.config);
    await testDb()('workspaces').where({ id: s.ws.id }).update({ digest_enabled: true, digest_hour: 9, timezone: 'Asia/Kolkata', digest_channel_id: s.devops.id });

    expect(await runDigestScan(deps, { now: DateTime.fromISO('2026-11-10T03:00:00Z') })).toEqual({ queued: 0 }); // 08:30 IST
    expect(await runDigestScan(deps, { now: DateTime.fromISO('2026-11-10T03:31:00Z') })).toEqual({ queued: 1 });
    expect(await runDigestScan(deps, { now: DateTime.fromISO('2026-11-10T10:00:00Z') })).toEqual({ queued: 0 });
    const digest = await testDb()('daily_digests').first();
    expect(digest).toMatchObject({ digest_date: '2026-11-10', status: 'queued' });

    const delivery = await testDb()('notification_deliveries').where({ kind: 'digest' }).first();
    expect(delivery.channel_id).toBe(s.devops.id);
    await sendDelivery(deps, delivery.id);
    const [, msg] = deps.slack.postMessage.mock.calls[0];
    expect(JSON.stringify(msg.blocks)).toContain('No GitHub activity'); // empty day handled
    expect(await runDigestScan(deps, { now: DateTime.fromISO('2026-11-11T03:31:00Z') })).toEqual({ queued: 1 });
  });

  it('marks the digest skipped when no channel is configured', async () => {
    const { deps } = buildApp();
    const s = await seedConnectedWorkspace(deps.config);
    await testDb()('notification_channels').where({ workspace_id: s.ws.id }).update({ enabled: false });
    await testDb()('workspaces').where({ id: s.ws.id }).update({ digest_enabled: true, digest_hour: 0 });
    await runDigestScan(deps);
    expect((await testDb()('daily_digests').first()).status).toBe('skipped');
  });
});

describe('concurrency', () => {
  beforeEach(resetDb);

  it('processes many deliveries concurrently without duplicates or lost events', async () => {
    const { app, deps } = buildApp();
    await seedConnectedWorkspace(deps.config);
    for (let i = 0; i < 20; i += 1) {
      await sendWebhook(app, deps.config, 'issues', issuePayload('opened', { issue: { id: 5000 + i, number: 100 + i, updated_at: new Date().toISOString() } }));
    }
    const ids = deps.queues.events.splice(0);
    // Every delivery is processed twice, concurrently, as a stalled-job re-run would.
    await Promise.all([...ids, ...ids].map((id) => processWebhookDelivery(deps, id)));
    expect(Number((await testDb()('events').count({ n: '*' }).first()).n)).toBe(20);
    expect(Number((await testDb()('issues').count({ n: '*' }).first()).n)).toBe(20);
    expect(Number((await testDb()('notification_deliveries').count({ n: '*' }).first()).n)).toBe(20);
    expect(await testDb()('webhook_deliveries').whereNot({ status: 'processed' }).count({ n: '*' }).first()).toEqual({ n: 0 });
  });

  it('applies out-of-order PR updates safely (older snapshot does not overwrite newer state)', async () => {
    const { app, deps } = buildApp();
    await seedConnectedWorkspace(deps.config);
    await sendWebhook(app, deps.config, 'pull_request', prPayload('closed', { pr: { state: 'closed', merged: true, merged_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' } }));
    await sendWebhook(app, deps.config, 'pull_request', prPayload('edited', { pr: { title: 'Old title', updated_at: '2026-11-01T00:00:00Z' } }));
    await process(deps);
    const pr = await testDb()('pull_requests').first();
    expect(pr).toMatchObject({ state: 'closed', merged: true, title: 'Add authentication' });
  });
});
