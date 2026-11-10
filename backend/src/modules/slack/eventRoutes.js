import express from 'express';
import { verifySlackSignature } from './signature.js';
import { metrics } from '../../shared/metrics.js';
import { logger } from '../../shared/logger.js';

/**
 * POST /api/v1/webhooks/slack/events — Slack Events API.
 * Handles URL verification and app removal/token revocation so we stop using dead tokens.
 */
export function slackEventRoutes(deps) {
  const { db, config } = deps;
  const router = express.Router();

  router.post('/events', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySlackSignature(config.slack.signingSecret, raw, req.get('x-slack-request-timestamp'), req.get('x-slack-signature'))) {
      metrics.webhooksRejected.inc({ provider: 'slack', reason: 'invalid_signature' });
      return res.status(401).json({ error: { code: 'invalid_signature', message: 'Signature verification failed' } });
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Body is not valid JSON' } });
    }

    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      return res.status(200).json({ challenge: body.challenge });
    }

    if (body.type === 'event_callback' && typeof body.team_id === 'string') {
      const type = body.event?.type;
      if (type === 'app_uninstalled' || type === 'tokens_revoked') {
        const n = await db('integrations')
          .where({ provider: 'slack', external_id: body.team_id })
          .whereIn('status', ['active', 'pending'])
          .update({
            status: 'revoked',
            credentials_encrypted: null,
            last_error: type === 'app_uninstalled' ? 'Slack app was uninstalled from the workspace' : 'Slack tokens were revoked',
            disconnected_at: db.fn.now(),
            updated_at: db.fn.now(),
          });
        logger.info({ team: body.team_id, type, updated: n }, 'Slack installation revoked');
      }
      metrics.webhooksReceived.inc({ provider: 'slack', event: type || 'unknown' });
    }
    res.status(200).json({ ok: true });
  });

  return router;
}
