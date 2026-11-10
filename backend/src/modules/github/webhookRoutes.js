import express from 'express';
import { verifyGitHubSignature } from './signature.js';
import { recordDelivery } from '../events/ingest.js';
import { metrics } from '../../shared/metrics.js';
import { logger } from '../../shared/logger.js';

const EVENT_NAME = /^[a-z_]{1,64}$/;
const DELIVERY_ID = /^[0-9a-fA-F-]{8,64}$/;

/**
 * POST /api/v1/webhooks/github
 * Mounted BEFORE the global JSON parser so the exact raw bytes are available for HMAC verification.
 */
export function githubWebhookRoutes(deps) {
  const { config } = deps;
  const router = express.Router();

  router.post('/', express.raw({ type: () => true, limit: config.webhookBodyLimit }), async (req, res) => {
    const reject = (status, reason, message) => {
      metrics.webhooksRejected.inc({ provider: 'github', reason });
      return res.status(status).json({ error: { code: reason, message } });
    };

    if (!config.github.webhookSecret) return reject(503, 'not_configured', 'GitHub webhooks are not configured');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyGitHubSignature(config.github.webhookSecret, raw, req.get('x-hub-signature-256'))) {
      logger.warn({ delivery: req.get('x-github-delivery') }, 'Rejected GitHub webhook with invalid signature');
      return reject(401, 'invalid_signature', 'Signature verification failed');
    }

    const eventName = req.get('x-github-event');
    const deliveryId = req.get('x-github-delivery');
    if (!eventName || !EVENT_NAME.test(eventName)) return reject(400, 'invalid_event', 'Missing or invalid X-GitHub-Event');
    if (!deliveryId || !DELIVERY_ID.test(deliveryId)) return reject(400, 'invalid_delivery', 'Missing or invalid X-GitHub-Delivery');

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reject(400, 'invalid_json', 'Body is not valid JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reject(400, 'invalid_payload', 'Payload must be an object');

    if (eventName === 'ping') return res.status(200).json({ data: { ok: true, zen: payload.zen ?? null } });

    const result = await recordDelivery(deps, {
      provider: 'github',
      deliveryId,
      eventName,
      action: typeof payload.action === 'string' ? payload.action.slice(0, 64) : null,
      installationExternalId: payload.installation?.id != null ? String(payload.installation.id) : null,
      payload,
      payloadBytes: raw.length,
    });
    // 202 only after the delivery is committed to PostgreSQL.
    res.status(result.duplicate ? 200 : 202).json({ data: { accepted: true, duplicate: result.duplicate } });
  });

  return router;
}
