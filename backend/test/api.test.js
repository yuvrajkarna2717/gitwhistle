import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, resetDb, testDb, seedConnectedWorkspace, sendWebhook, prPayload, workflowRunPayload, authed } from './helpers.js';
import { processWebhookDelivery } from '../src/modules/events/processor.js';

describe('dashboard and configuration API', () => {
  beforeEach(resetDb);

  it('supports notification rule CRUD, validation and preview', async () => {
    const { app, deps } = buildApp();
    const s = await seedConnectedWorkspace(deps.config);
    const api = authed(app, s.session);
    const base = `/api/v1/workspaces/${s.ws.id}/notification-rules`;

    const meta = await api.get(`${base}/meta`);
    expect(meta.body.data.eventTypes).toContain('workflow_run.completed');
    expect(meta.body.data.fields.workflowConclusion).toBeTruthy();

    const bad = await api.post(base).send({ name: 'x', conditions: [{ field: 'labels', operator: 'equals', value: 'x' }], actions: { channelIds: [s.devops.id] } });
    expect(bad.status).toBe(422);

    const rule = {
      name: 'CI failures to devops',
      priority: 5,
      conditions: [
        { field: 'eventType', operator: 'equals', value: 'workflow_run.completed' },
        { field: 'workflowConclusion', operator: 'equals', value: 'failure' },
      ],
      actions: { channelIds: [s.devops.id], priority: 'high' },
    };
    const created = await api.post(base).send(rule);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: rule.name, enabled: true, actions: { priority: 'high', stopProcessing: false } });

    await sendWebhook(app, deps.config, 'workflow_run', workflowRunPayload('failure'));
    for (const id of deps.queues.events.splice(0)) await processWebhookDelivery(deps, id);
    const event = await testDb()('events').first();
    const delivery = await testDb()('notification_deliveries').first();
    expect(delivery).toMatchObject({ channel_id: s.devops.id, priority: 'high' });

    const preview = await api.post(`${base}/preview`).send({ eventId: event.id });
    expect(preview.body.data).toMatchObject({ matchedRuleIds: [created.body.data.id], priority: 'high', channels: [{ channelName: 'devops' }] });
    const dry = await api.post(`${base}/preview`).send({ rule: { ...rule, conditions: [{ field: 'eventType', operator: 'equals', value: 'push' }] } });
    expect(dry.body.data).toMatchObject({ evaluated: 1, matched: 0 });

    const patched = await api.patch(`${base}/${created.body.data.id}`).send({ enabled: false });
    expect(patched.body.data.enabled).toBe(false);
    expect((await api.get(base)).body.data).toHaveLength(1);
    expect((await api.delete(`${base}/${created.body.data.id}`)).status).toBe(204);
    expect(await testDb()('audit_logs').whereIn('action', ['rule.created', 'rule.updated', 'rule.deleted']).count({ n: '*' }).first()).toEqual({ n: 3 });
  });

  it('serves overview, activity filters, notification history and settings', async () => {
    const { app, deps } = buildApp();
    const s = await seedConnectedWorkspace(deps.config);
    const api = authed(app, s.session);
    const base = `/api/v1/workspaces/${s.ws.id}`;
    const now = new Date().toISOString();
    await sendWebhook(app, deps.config, 'pull_request', prPayload('opened', { pr: { updated_at: now } }));
    const run = workflowRunPayload('failure');
    await sendWebhook(app, deps.config, 'workflow_run', { ...run, workflow_run: { ...run.workflow_run, updated_at: now } });
    for (const id of deps.queues.events.splice(0)) await processWebhookDelivery(deps, id);

    const overview = await api.get(`${base}/overview`);
    expect(overview.body.data).toMatchObject({ repositories: { total: 1, monitored: 1 }, pullRequests: { open: 1 }, issues: { open: 0 } });
    expect(overview.body.data.github[0].status).toBe('active');
    expect(overview.body.data.recentEvents).toHaveLength(2);

    const prsOnly = await api.get(`${base}/events?eventType=pull_request&pageSize=10`);
    expect(prsOnly.body.data.map((e) => e.eventType)).toEqual(['pull_request.opened']);
    expect(prsOnly.body.meta).toMatchObject({ page: 1, pageSize: 10, total: 1 });
    expect((await api.get(`${base}/events?status=failure`)).body.data).toHaveLength(1);
    expect((await api.get(`${base}/events?actor=BOB`)).body.data).toHaveLength(2);
    expect((await api.get(`${base}/events?eventType=DROP TABLE`)).status).toBe(422);
    expect((await api.get(`${base}/events/types`)).body.data).toEqual(['pull_request.opened', 'workflow_run.completed']);

    const notifications = await api.get(`${base}/notifications`);
    expect(notifications.body.data).toHaveLength(2);
    expect(notifications.body.data[0]).toMatchObject({ status: 'pending', channel: { name: 'backend' } });

    const policy = await api.put(`${base}/reminder-policies/review_pending`).send({ enabled: true, thresholdHours: 12, repeatHours: null, channelId: s.devops.id });
    expect(policy.body.data).toMatchObject({ enabled: true, thresholdHours: 12, channelId: s.devops.id });
    expect((await api.put(`${base}/reminder-policies/review_pending`).send({ enabled: true, thresholdHours: 0 })).status).toBe(422);

    const settings = await api.patch(base).send({ digestEnabled: true, digestHour: 8, timezone: 'Asia/Kolkata', digestChannelId: s.devops.id });
    expect(settings.body.data).toMatchObject({ digestEnabled: true, digestHour: 8, timezone: 'Asia/Kolkata' });
    const preview = await api.get(`${base}/digests/preview`);
    expect(preview.body.data.summary).toMatchObject({ prsOpened: 1, failedWorkflows: 1 });
    const testDigest = await api.post(`${base}/digests/test`);
    expect(testDigest.body.data.outcome).toBe('sent');

    const repo = await api.patch(`${base}/repositories/${s.repo.id}`).send({ monitoringEnabled: false });
    expect(repo.body.data.monitoringEnabled).toBe(false);
    expect((await api.patch(`${base}/repositories/${s.repo.id}`).send({ monitoringEnabled: true })).status).toBe(200);
    expect(deps.queues.tasks).toContainEqual({ name: 'sync-repository', data: { repositoryId: s.repo.id } });
  });

  it('exposes health, readiness and protected metrics', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/healthz')).body.status).toBe('ok');
    expect((await request(app).get('/readyz')).body.checks).toEqual({ database: 'ok', redis: 'ok' });
    expect((await request(app).get('/metrics')).status).toBe(401);
    const m = await request(app).get('/metrics').set('Authorization', 'Bearer metrics-token');
    expect(m.text).toContain('gitwhistle_webhooks_received_total');
    expect((await request(app).get('/api/v1/nope')).status).toBe(404);
  });
});
