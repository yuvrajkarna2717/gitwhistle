import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildApp, resetDb, testDb, seedConnectedWorkspace, sendWebhook, prPayload, workflowRunPayload, issuePayload, fakeSlack, authed } from './helpers.js';
import { processWebhookDelivery } from '../src/modules/events/processor.js';
import { sendDelivery } from '../src/modules/notifications/deliveries.js';
import { runOutboxRelay } from '../src/modules/events/relay.js';

async function drain(deps) {
  for (const id of deps.queues.events.splice(0)) await processWebhookDelivery(deps, id, { throwOnRetry: false });
  const results = [];
  for (const id of deps.queues.deliveries.splice(0)) results.push(await sendDelivery(deps, id));
  return results;
}

const count = async (table, where = {}) => Number((await testDb()(table).where(where).count({ n: '*' }).first()).n);

describe('webhook ingestion', () => {
  beforeEach(resetDb);

  it('rejects missing and invalid signatures without storing anything', async () => {
    const { app, deps } = buildApp();
    expect((await sendWebhook(app, deps.config, 'push', { a: 1 }, { signature: '' })).status).toBe(401);
    expect((await sendWebhook(app, deps.config, 'push', { a: 1 }, { secret: 'wrong' })).status).toBe(401);
    expect((await sendWebhook(app, deps.config, 'push', { a: 1 }, { signature: 'sha256=' + '0'.repeat(64) })).status).toBe(401);
    expect(await count('webhook_deliveries')).toBe(0);
    expect(deps.queues.enqueueEvent).not.toHaveBeenCalled();
  });

  it('durably records a delivery before acknowledging, then enqueues it', async () => {
    const { app, deps } = buildApp();
    const res = await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'));
    expect(res.status).toBe(202);
    const row = await testDb()('webhook_deliveries').first();
    expect(row).toMatchObject({ provider: 'github', event_name: 'pull_request', action: 'opened', installation_external_id: '555', status: 'pending' });
    expect(row.payload.pull_request.number).toBe(42);
    expect(deps.queues.events).toEqual([row.id]);
  });

  it('treats redeliveries of the same delivery id as duplicates', async () => {
    const { app, deps } = buildApp();
    const deliveryId = '11111111-2222-4333-8444-555555555555';
    expect((await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'), { deliveryId })).status).toBe(202);
    const again = await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'), { deliveryId });
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    expect(await count('webhook_deliveries')).toBe(1);
    expect(deps.queues.events).toHaveLength(1);
  });

  it('still acknowledges when Redis is down, and the outbox relay enqueues later', async () => {
    const { app, deps } = buildApp();
    deps.queues.fail = true;
    expect((await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'))).status).toBe(202);
    expect(deps.queues.events).toHaveLength(0);
    const relayDown = await runOutboxRelay(deps);
    expect(relayDown.events).toBe(0);
    deps.queues.fail = false;
    const relayed = await runOutboxRelay(deps);
    expect(relayed.events).toBe(1);
    expect(deps.queues.events).toHaveLength(1);
    expect((await runOutboxRelay(deps)).events).toBe(0); // not re-enqueued while recently enqueued
  });

  it('accepts multi-megabyte payloads and rejects ones above the configured limit', async () => {
    const { app, deps } = buildApp();
    const big = prPayload('opened', { pr: { body: 'x'.repeat(3 * 1024 * 1024) } });
    expect((await sendWebhook(app, deps.config, 'pull_request', big)).status).toBe(202);
    const small = buildApp({ configOverrides: { webhookBodyLimit: '1kb' } });
    expect((await sendWebhook(small.app, small.deps.config, 'pull_request', big)).status).toBe(413);
  });

  it('answers ping without storing', async () => {
    const { app, deps } = buildApp();
    expect((await sendWebhook(app, deps.config, 'ping', { zen: 'hi', hook_id: 1 })).status).toBe(200);
    expect(await count('webhook_deliveries')).toBe(0);
  });
});

describe('event processing and Slack delivery', () => {
  beforeEach(resetDb);

  it('GitHub PR → canonical event → rule → Slack message in the right channel', async () => {
    const { app, deps } = buildApp();
    const s = await seedConnectedWorkspace(deps.config);
    await testDb()('notification_rules').insert({
      workspace_id: s.ws.id,
      name: 'Backend PRs',
      priority: 10,
      conditions: JSON.stringify([
        { field: 'eventType', operator: 'equals', value: 'pull_request.opened' },
        { field: 'repository', operator: 'equals', value: 'acme/api' },
        { field: 'branch', operator: 'equals', value: 'main' },
      ]),
      actions: { channelIds: [s.devops.id], priority: 'normal', stopProcessing: false, suppress: false },
    });

    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'));
    const [sent] = await drain(deps);
    expect(sent.outcome).toBe('sent');

    const event = await testDb()('events').first();
    expect(event).toMatchObject({ workspace_id: s.ws.id, event_type: 'pull_request.opened', repository_id: s.repo.id, actor_login: 'bob', resource_number: 42 });
    const pr = await testDb()('pull_requests').first();
    expect(pr).toMatchObject({ number: 42, state: 'open', base_ref: 'main', head_ref: 'feature/auth', requested_reviewers: ['carol'] });

    expect(deps.slack.postMessage).toHaveBeenCalledOnce();
    const [token, msg] = deps.slack.postMessage.mock.calls[0];
    expect(token).toBe('xoxb-seeded'); // decrypted only inside the worker
    expect(msg.channel).toBe(s.devops.external_id);
    expect(JSON.stringify(msg.blocks)).toContain('Add authentication');

    const delivery = await testDb()('notification_deliveries').first();
    expect(delivery).toMatchObject({ status: 'sent', channel_id: s.devops.id, event_id: event.id, attempts: 1 });
    expect(delivery.external_message_id).toMatch(/^1700000000\./);
    expect((await testDb()('webhook_deliveries').first()).status).toBe('processed');

    // The dashboard shows the event and the delivery result.
    const feed = await authed(app, s.session).get(`/api/v1/workspaces/${s.ws.id}/events`);
    expect(feed.body.data[0]).toMatchObject({ eventType: 'pull_request.opened', repository: { fullName: 'acme/api' } });
    const detail = await authed(app, s.session).get(`/api/v1/workspaces/${s.ws.id}/events/${event.id}`);
    expect(detail.body.data.deliveries[0]).toMatchObject({ status: 'sent', channelName: 'devops' });
  });

  it('never sends twice for redelivered webhooks or re-run jobs', async () => {
    const { app, deps } = buildApp();
    await seedConnectedWorkspace(deps.config);
    const deliveryId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'), { deliveryId });
    const rowId = deps.queues.events[0];
    await drain(deps);
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'), { deliveryId });
    await processWebhookDelivery(deps, rowId); // e.g. a stalled job re-run
    await testDb()('webhook_deliveries').update({ status: 'pending' }); // even if status were reset
    await processWebhookDelivery(deps, rowId);
    for (const d of await testDb()('notification_deliveries')) await sendDelivery(deps, d.id);
    expect(await count('events')).toBe(1);
    expect(await count('notification_deliveries')).toBe(1);
    expect(deps.slack.postMessage).toHaveBeenCalledOnce();
  });

  it('records failures with retry state, dead-letters after max attempts, and can be reprocessed', async () => {
    const { app, deps } = buildApp({ configOverrides: {} });
    deps.config = { ...deps.config, worker: { ...deps.config.worker, eventMaxAttempts: 2 } };
    const s = await seedConnectedWorkspace(deps.config);
    const realSource = deps.registry.sources.github.normalize;
    deps.registry.sources.github.normalize = () => {
      throw new Error('boom');
    };
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'));
    const id = deps.queues.events[0];

    await expect(processWebhookDelivery(deps, id)).rejects.toThrow('boom');
    let row = await testDb()('webhook_deliveries').where({ id }).first();
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row.last_error).toContain('boom');
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect(await count('events')).toBe(0); // nothing half-written

    await expect(processWebhookDelivery(deps, id)).rejects.toThrow('boom'); // UnrecoverableError on the final attempt
    row = await testDb()('webhook_deliveries').where({ id }).first();
    expect(row).toMatchObject({ status: 'dead', attempts: 2 });
    expect(await count('event_processing_attempts', { webhook_delivery_id: id })).toBe(2);
    expect(await processWebhookDelivery(deps, id)).toEqual({ outcome: 'already_done' });

    deps.registry.sources.github.normalize = realSource;
    const res = await authed(app, s.session).post(`/api/v1/workspaces/${s.ws.id}/webhook-deliveries/${id}/reprocess`);
    expect(res.status).toBe(200);
    await drain(deps);
    expect((await testDb()('webhook_deliveries').where({ id }).first()).status).toBe('processed');
    expect(deps.slack.postMessage).toHaveBeenCalledOnce();
  });

  it('retries Slack rate limits and transient errors, dead-letters permanent errors, and handles revoked tokens', async () => {
    const slack = fakeSlack();
    const { app, deps } = buildApp({ slack });
    const s = await seedConnectedWorkspace(deps.config);
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'));
    for (const id of deps.queues.events.splice(0)) await processWebhookDelivery(deps, id);
    const [deliveryId] = deps.queues.deliveries.splice(0);

    slack.postMessage.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 30 }));
    expect(await sendDelivery(deps, deliveryId)).toMatchObject({ outcome: 'retry', delayMs: 30000 });
    let d = await testDb()('notification_deliveries').where({ id: deliveryId }).first();
    expect(d.status).toBe('failed');
    expect(new Date(d.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 25_000);

    slack.postMessage.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'slack_webapi_request_error' }));
    expect((await sendDelivery(deps, deliveryId)).outcome).toBe('retry');
    expect((await sendDelivery(deps, deliveryId)).outcome).toBe('sent');
    expect(await sendDelivery(deps, deliveryId)).toEqual({ outcome: 'noop' }); // already sent: never resent
    expect(slack.postMessage).toHaveBeenCalledTimes(3);

    // Permanent error
    await sendWebhook(app, deps.config, 'issues', issuePayload('opened'));
    for (const id of deps.queues.events.splice(0)) await processWebhookDelivery(deps, id);
    const [issueDelivery] = deps.queues.deliveries.splice(0);
    slack.postMessage.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'slack_webapi_platform_error', data: { error: 'channel_not_found' } }));
    expect((await sendDelivery(deps, issueDelivery)).outcome).toBe('dead');

    // Revoked token marks the integration revoked; later deliveries are skipped, not attempted.
    await sendWebhook(app, deps.config, 'workflow_run', workflowRunPayload('failure'));
    for (const id of deps.queues.events.splice(0)) await processWebhookDelivery(deps, id);
    const [ciDelivery] = deps.queues.deliveries.splice(0);
    slack.postMessage.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'slack_webapi_platform_error', data: { error: 'token_revoked' } }));
    expect((await sendDelivery(deps, ciDelivery)).outcome).toBe('dead');
    expect((await testDb()('integrations').where({ id: s.slackInt.id }).first()).status).toBe('revoked');
    d = await testDb()('notification_deliveries').where({ id: ciDelivery }).first();
    expect(d.last_error).toContain('revoked');
  });

  it('dead-letters a delivery after the maximum attempts', async () => {
    const slack = fakeSlack({ postMessage: vi.fn().mockRejectedValue(Object.assign(new Error('500'), { code: 'slack_webapi_platform_error', data: { error: 'internal_error' } })) });
    const { app, deps } = buildApp({ slack });
    deps.config = { ...deps.config, worker: { ...deps.config.worker, deliveryMaxAttempts: 3 } };
    await seedConnectedWorkspace(deps.config);
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'));
    for (const id of deps.queues.events.splice(0)) await processWebhookDelivery(deps, id);
    const [id] = deps.queues.deliveries;
    expect((await sendDelivery(deps, id)).outcome).toBe('retry');
    expect((await sendDelivery(deps, id)).outcome).toBe('retry');
    expect((await sendDelivery(deps, id)).outcome).toBe('dead');
    expect(slack.postMessage).toHaveBeenCalledTimes(3);
  });

  it('recovers deliveries stuck in "sending" after a worker crash', async () => {
    const { app, deps } = buildApp();
    await seedConnectedWorkspace(deps.config);
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'));
    for (const id of deps.queues.events.splice(0)) await processWebhookDelivery(deps, id);
    deps.queues.deliveries.length = 0;
    await testDb()('notification_deliveries').update({ status: 'sending', locked_at: new Date(Date.now() - 3600_000), enqueued_at: new Date(Date.now() - 3600_000) });
    const r = await runOutboxRelay(deps);
    expect(r).toMatchObject({ unstuck: 1, deliveries: 1 });
    await sendDelivery(deps, deps.queues.deliveries[0]);
    expect((await testDb()('notification_deliveries').first()).status).toBe('sent');
  });

  it('ignores events for unmonitored repositories and suspended installations', async () => {
    const { app, deps } = buildApp();
    const s = await seedConnectedWorkspace(deps.config);
    await testDb()('repositories').where({ id: s.repo.id }).update({ monitoring_enabled: false });
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'));
    await drain(deps);
    expect((await testDb()('webhook_deliveries').first()).ignore_reason).toBe('repository not monitored');
    expect(await count('events')).toBe(0);
    expect(deps.slack.postMessage).not.toHaveBeenCalled();
  });

  it('notifies on reviews, issues, failed workflows and releases with fallback routing', async () => {
    const { app, deps } = buildApp();
    const s = await seedConnectedWorkspace(deps.config);
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened'));
    await sendWebhook(app, deps.config, 'pull_request_review', {
      ...prPayload('submitted'),
      action: 'submitted',
      review: { id: 1, user: { login: 'carol' }, state: 'changes_requested', submitted_at: '2026-11-01T12:00:00Z', html_url: 'https://github.com/acme/api/pull/42#r1', commit_id: 'abc' },
    });
    await sendWebhook(app, deps.config, 'issues', issuePayload('opened'));
    await sendWebhook(app, deps.config, 'workflow_run', workflowRunPayload('failure'));
    await sendWebhook(app, deps.config, 'workflow_run', workflowRunPayload('success'));
    await sendWebhook(app, deps.config, 'release', {
      action: 'published',
      release: { id: 5, name: 'v1.0', tag_name: 'v1.0.0', html_url: 'https://github.com/acme/api/releases/v1.0.0', author: { login: 'bob' }, published_at: '2026-11-02T00:00:00Z' },
      repository: { id: 1, full_name: 'acme/api' },
      installation: { id: 555 },
      sender: { login: 'bob' },
    });
    await drain(deps);

    const texts = deps.slack.postMessage.mock.calls.map(([, m]) => m.text);
    expect(texts).toHaveLength(5); // the successful workflow run is not notable by default
    expect(texts.join('\n')).toMatch(/PR #42 opened/);
    expect(texts.join('\n')).toMatch(/carol changes requested PR #42/);
    expect(texts.join('\n')).toMatch(/Issue #7 opened/);
    expect(texts.join('\n')).toMatch(/Workflow CI failure on main/);
    expect(texts.join('\n')).toMatch(/Release v1.0 \(v1.0.0\) published/);
    expect(deps.slack.postMessage.mock.calls.every(([, m]) => m.channel === s.channel.external_id)).toBe(true);

    const pr = await testDb()('pull_requests').first();
    expect(pr.review_state).toBe('changes_requested');
    expect(await count('issues')).toBe(1);
  });
});
