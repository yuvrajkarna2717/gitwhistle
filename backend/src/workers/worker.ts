import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { processWebhookJob } from '../jobs/webhookProcessor';

const connection = new IORedis(process.env.REDIS_URL as string, {
  maxRetriesPerRequest: null
});

const worker = new Worker('webhook-queue', async job => {
  if (job.name === 'github-event') {
    await processWebhookJob(job.data);
  }
}, { connection });

worker.on('completed', job => console.log('job done', job.id));
worker.on('failed', (job, err) => console.error('job failed', job?.id, err));
