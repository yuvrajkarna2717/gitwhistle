import crypto from 'node:crypto';

const MAX_SKEW_SECONDS = 60 * 5;

/**
 * Verifies a Slack request signature (v0) over the raw body, rejecting stale timestamps to
 * prevent replay. https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(signingSecret, rawBody, timestampHeader, signatureHeader, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!signingSecret || !Buffer.isBuffer(rawBody)) return false;
  if (typeof timestampHeader !== 'string' || !/^\d{1,12}$/.test(timestampHeader)) return false;
  if (Math.abs(nowSeconds - Number(timestampHeader)) > MAX_SKEW_SECONDS) return false;
  if (typeof signatureHeader !== 'string' || !/^v0=[0-9a-f]{64}$/.test(signatureHeader)) return false;
  const base = Buffer.concat([Buffer.from(`v0:${timestampHeader}:`), rawBody]);
  const expected = crypto.createHmac('sha256', signingSecret).update(base).digest();
  const received = Buffer.from(signatureHeader.slice(3), 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(expected, received);
}

export function signSlackPayload(signingSecret, rawBody, timestamp) {
  const base = Buffer.concat([Buffer.from(`v0:${timestamp}:`), Buffer.from(rawBody)]);
  return `v0=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;
}
