import express from 'express';
import crypto from 'crypto';
import { Queue } from 'bullmq';
import { webhookQueueName } from '../jobs';
import IORedis from 'ioredis';

const router = express.Router();

// Test endpoint
router.get('/github', (req, res) => {
  res.json({ message: 'GitHub webhook endpoint is working' });
});

const redis = new IORedis(process.env.REDIS_URL as string);

function verifySignature(secret: string, payload: Buffer, signatureHeader: string | undefined) {
  if (!signatureHeader) return false;
  const sig = Buffer.from(signatureHeader.replace('sha256=', ''), 'hex');
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest();
  return crypto.timingSafeEqual(hmac, sig);
}

router.post('/github', async (req, res) => {
  try {
    const event = req.headers['x-github-event'] as string;
    const delivery = req.headers['x-github-delivery'] as string;
    const payload = req.body;
    
    console.log('Webhook:', event, delivery);
    
    const queue = new Queue(webhookQueueName, { connection: { url: process.env.REDIS_URL } });
    await queue.add('github-event', { event, delivery, payload });

    res.status(202).send('accepted');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('error');
  }
});

export default router;
