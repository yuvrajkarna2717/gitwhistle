import { WebClient, ErrorCode, LogLevel } from '@slack/web-api';
import { serviceUnavailable } from '../../shared/errors.js';

export const SLACK_BOT_SCOPES = ['chat:write', 'chat:write.public', 'channels:read', 'groups:read'];

/** Slack errors that mean the token or app installation is no longer valid. */
const REVOKED_ERRORS = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed', 'token_expired', 'team_disabled', 'missing_scope']);
/** Errors that will not succeed on retry. */
const PERMANENT_ERRORS = new Set([
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'msg_too_long',
  'invalid_blocks',
  'invalid_blocks_format',
  'no_text',
  'restricted_action',
  'ekm_access_denied',
  'too_many_attachments',
  'invalid_arguments',
]);

/**
 * Classify an error from the Slack Web API.
 * @returns {{ kind: 'rate_limited'|'revoked'|'permanent'|'retryable', retryAfterMs?: number, slackError?: string }}
 */
export function classifySlackError(err) {
  if (err?.code === ErrorCode.RateLimitedError) return { kind: 'rate_limited', retryAfterMs: (Number(err.retryAfter) || 30) * 1000 };
  if (err?.code === ErrorCode.PlatformError) {
    const slackError = err.data?.error;
    if (slackError === 'ratelimited') return { kind: 'rate_limited', retryAfterMs: 30_000, slackError };
    if (REVOKED_ERRORS.has(slackError)) return { kind: 'revoked', slackError };
    if (PERMANENT_ERRORS.has(slackError)) return { kind: 'permanent', slackError };
    return { kind: 'retryable', slackError };
  }
  if (err?.code === ErrorCode.HTTPError && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
    return { kind: 'permanent', slackError: `http_${err.statusCode}` };
  }
  return { kind: 'retryable', slackError: err?.code || 'network_error' };
}

/** Real Slack client; tests substitute a fake with the same shape. */
export function createSlackClient(config) {
  const sc = config.slack;
  const options = {
    logLevel: LogLevel.ERROR,
    rejectRateLimitedCalls: true, // we schedule the retry ourselves instead of blocking a worker
    retryConfig: { retries: 0 },
    timeout: 15_000,
    ...(sc.apiUrl ? { slackApiUrl: sc.apiUrl } : {}),
  };
  const client = (token) => new WebClient(token, options);
  const requireSlack = () => {
    if (!sc.enabled) throw serviceUnavailable('Slack is not configured on this server');
  };

  return {
    authorizeUrl({ state, redirectUri }) {
      requireSlack();
      const u = new URL('https://slack.com/oauth/v2/authorize');
      u.searchParams.set('client_id', sc.clientId);
      u.searchParams.set('scope', SLACK_BOT_SCOPES.join(','));
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      return u.toString();
    },

    async exchangeCode({ code, redirectUri }) {
      requireSlack();
      const res = await client().oauth.v2.access({ client_id: sc.clientId, client_secret: sc.clientSecret, code, redirect_uri: redirectUri });
      if (!res.ok || !res.access_token || res.token_type !== 'bot') throw new Error('Slack OAuth did not return a bot token');
      return {
        botToken: res.access_token,
        botUserId: res.bot_user_id,
        appId: res.app_id,
        scopes: (res.scope || '').split(',').filter(Boolean),
        team: { id: res.team?.id, name: res.team?.name },
        enterprise: res.enterprise ? { id: res.enterprise.id, name: res.enterprise.name } : null,
        installerUserId: res.authed_user?.id ?? null,
      };
    },

    /** All non-archived public channels, plus private channels the bot has been invited to. */
    async listChannels(botToken) {
      const channels = [];
      for await (const page of client(botToken).paginate('conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
      })) {
        for (const c of page.channels || []) {
          channels.push({ id: c.id, name: c.name, isPrivate: Boolean(c.is_private), isMember: Boolean(c.is_member), isArchived: Boolean(c.is_archived) });
        }
        if (channels.length >= 5000) break;
      }
      return channels;
    },

    async postMessage(botToken, { channel, text, blocks }) {
      const res = await client(botToken).chat.postMessage({ channel, text, blocks, unfurl_links: false, unfurl_media: false });
      return { ts: res.ts, channel: res.channel };
    },

    async revoke(botToken) {
      await client(botToken).auth.revoke();
    },
  };
}
