import { normalizeGitHubEvent, LIFECYCLE_EVENTS } from '../github/adapter.js';
import { renderEvent, renderReminder, renderDigest } from '../slack/blocks.js';
import { classifySlackError } from '../slack/client.js';
import { decryptJson } from '../../shared/crypto.js';

/**
 * Provider registry. The event engine and notification engine only talk to these interfaces:
 *
 * Source provider:      { id, isLifecycleEvent(name), normalize(eventName, payload, ctx) -> canonical | null }
 * Destination provider: { id, renderEvent, renderReminder, renderDigest, send(ctx) -> { externalMessageId },
 *                         classifyError(err) -> { kind: rate_limited|revoked|permanent|retryable, retryAfterMs? } }
 *
 * Adding GitLab means adding a source here plus its webhook route; adding Teams means adding a destination.
 */
export function createRegistry({ config, slack }) {
  const sources = {
    github: {
      id: 'github',
      isLifecycleEvent: (eventName) => LIFECYCLE_EVENTS.has(eventName),
      normalize: normalizeGitHubEvent,
    },
  };

  const destinations = {
    slack: {
      id: 'slack',
      renderEvent,
      renderReminder,
      renderDigest,
      async send({ integration, channel, message }) {
        const creds = decryptJson(integration.credentials_encrypted, config.encryptionKey);
        if (!creds?.botToken) {
          const err = new Error('Slack credentials missing');
          err.data = { error: 'not_authed' };
          err.code = 'slack_webapi_platform_error';
          throw err;
        }
        const res = await slack.postMessage(creds.botToken, { channel: channel.external_id, text: message.text, blocks: message.blocks });
        return { externalMessageId: res.ts };
      },
      classifyError: classifySlackError,
    },
  };

  return {
    sources,
    destinations,
    source(id) {
      const s = sources[id];
      if (!s) throw new Error(`Unknown source provider: ${id}`);
      return s;
    },
    destination(id) {
      const d = destinations[id];
      if (!d) throw new Error(`Unknown destination provider: ${id}`);
      return d;
    },
  };
}
