import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { processWebhookJob } from './webhookProcessor';

export const webhookQueueName = 'webhook-queue';

let connection = new IORedis(process.env.REDIS_URL as string, {
  maxRetriesPerRequest: null
});

export async function initQueues() {
  // Start a worker in a separate process ideally; for dev we can create inline worker.
  new Worker(webhookQueueName, async job => {
    if (job.name === 'github-event') {
      await processWebhookJob(job.data);
    }
  }, { connection });
}
