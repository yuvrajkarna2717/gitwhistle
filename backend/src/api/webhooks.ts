import express from 'express';
import crypto from 'crypto';
import { Queue } from 'bullmq';
import { webhookQueueName } from '../jobs';
import IORedis from 'ioredis';

const router = express.Router();

const redis = new IORedis(process.env.REDIS_URL as string);

function verifySignature(secret: string, payload: Buffer, signatureHeader: string | undefined) {
  if (!signatureHeader) return false;
  const sig = Buffer.from(signatureHeader.replace('sha256=', ''), 'hex');
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest();
  return crypto.timingSafeEqual(hmac, sig);
}

router.post('/github', express.raw({ type: '*/*' }), async (req, res) => {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET || '';
  const isValid = verifySignature(secret, req.body, (req.headers['x-hub-signature-256'] as string) || '');
  if (!isValid) return res.status(401).send('invalid signature');

  const event = req.headers['x-github-event'] as string;
  const delivery = req.headers['x-github-delivery'] as string;
  const payload = JSON.parse(req.body.toString());

  const queue = new Queue(webhookQueueName, { connection: { url: process.env.REDIS_URL } });
  await queue.add('github-event', { event, delivery, payload }, { removeOnComplete: true, removeOnFail: true });

  res.status(202).send('accepted');
});

export default router;
