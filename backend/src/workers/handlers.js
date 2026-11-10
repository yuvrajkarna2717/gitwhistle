import { processWebhookDelivery } from '../modules/events/processor.js';
import { sendDelivery } from '../modules/notifications/deliveries.js';
import { runOutboxRelay, purgeOldPayloads } from '../modules/events/relay.js';
import { syncInstallation, syncRepository } from '../modules/github/installations.js';
import { runReminderScan } from '../modules/reminders/scanner.js';
import { runDigestScan } from '../modules/digests/digest.js';
import { purgeExpiredSessions } from '../modules/auth/sessions.js';
import { purgeExpiredOAuthStates } from '../modules/auth/oauthState.js';
import { metrics } from '../shared/metrics.js';

/** Repeatable jobs: name -> interval. */
export const SCHEDULES = {
  'outbox-relay': 30_000,
  'reminder-scan': 15 * 60_000,
  'digest-scan': 5 * 60_000,
  maintenance: 60 * 60_000,
  'queue-metrics': 30_000,
};

export function createHandlers(deps) {
  const { db, config, queues } = deps;
  return {
    events: (job) => processWebhookDelivery(deps, job.data.deliveryRowId),
    deliveries: (job, token) => sendDelivery(deps, job.data.deliveryId, { job, token }),
    tasks: async (job) => {
      switch (job.name) {
        case 'sync-installation':
          return syncInstallation(deps, job.data.integrationId);
        case 'sync-repository':
          return syncRepository(deps, job.data.repositoryId);
        case 'outbox-relay':
          return runOutboxRelay(deps);
        case 'reminder-scan':
          return runReminderScan(deps);
        case 'digest-scan':
          return runDigestScan(deps);
        case 'maintenance':
          return {
            payloadsPurged: await purgeOldPayloads(db, config.retention.webhookPayloadDays),
            sessionsPurged: await purgeExpiredSessions(db),
            statesPurged: await purgeExpiredOAuthStates(db),
          };
        case 'queue-metrics': {
          for (const [name, queue] of Object.entries(queues.queues)) {
            const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
            for (const [state, n] of Object.entries(counts)) metrics.queueDepth.set({ queue: name, state }, n);
          }
          return null;
        }
        default:
          throw new Error(`Unknown task: ${job.name}`);
      }
    },
  };
}
