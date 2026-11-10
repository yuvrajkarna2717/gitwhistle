import pino from 'pino';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

export const logger = pino({
  level,
  base: { service: process.env.GW_SERVICE || (process.argv[1]?.endsWith('worker.js') ? 'worker' : 'api') },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-hub-signature-256"]',
      'req.headers["x-slack-signature"]',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.token',
      '*.accessToken',
      '*.access_token',
      '*.botToken',
      '*.bot_token',
      '*.client_secret',
      '*.clientSecret',
      '*.privateKey',
      '*.credentials_encrypted',
      'err.config',
      'err.request',
      'err.response.headers',
      'err.data.response_metadata',
    ],
    censor: '[redacted]',
  },
  ...(process.env.NODE_ENV === 'development' && !process.env.LOG_JSON
    ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
    : {}),
});

/** Strip query strings from URLs before logging (OAuth codes and state travel there). */
export function safeUrl(url) {
  if (!url) return url;
  const i = url.indexOf('?');
  return i === -1 ? url : `${url.slice(0, i)}?[redacted]`;
}

/** Produce a log-safe summary of an error (no request configs, tokens, or payloads). */
export function errSummary(err) {
  if (!err) return undefined;
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    status: err.status ?? err.statusCode,
    slackError: err.data?.error,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  };
}
