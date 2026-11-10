import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'gitwhistle_' });

const counter = (name, help, labelNames = []) =>
  new client.Counter({ name: `gitwhistle_${name}`, help, labelNames, registers: [registry] });

export const metrics = {
  webhooksReceived: counter('webhooks_received_total', 'Webhook requests accepted', ['provider', 'event']),
  webhooksRejected: counter('webhooks_rejected_total', 'Webhook requests rejected', ['provider', 'reason']),
  webhooksDuplicate: counter('webhooks_duplicate_total', 'Webhook redeliveries ignored', ['provider']),
  eventsProcessed: counter('events_processed_total', 'Webhook deliveries processed', ['provider', 'outcome']),
  eventsFailed: counter('events_failed_total', 'Webhook delivery processing failures', ['provider', 'final']),
  notificationDeliveries: counter('notification_deliveries_total', 'Notification delivery attempts', [
    'provider',
    'outcome',
  ]),
  githubApiErrors: counter('github_api_errors_total', 'GitHub API errors', ['status']),
  outboxRequeued: counter('outbox_requeued_total', 'Rows re-enqueued by the outbox relay', ['kind']),
  processingLatency: new client.Histogram({
    name: 'gitwhistle_event_processing_latency_seconds',
    help: 'Time from webhook receipt to processing completion',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 900],
    registers: [registry],
  }),
  queueDepth: new client.Gauge({
    name: 'gitwhistle_queue_jobs',
    help: 'BullMQ job counts by queue and state (sampled by the worker)',
    labelNames: ['queue', 'state'],
    registers: [registry],
  }),
};
