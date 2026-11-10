import crypto from 'node:crypto';

/**
 * Verifies X-Hub-Signature-256 against the exact raw request bytes.
 * Never call this with re-serialized JSON: any whitespace or key-order change breaks the HMAC.
 */
export function verifyGitHubSignature(secret, rawBody, signatureHeader) {
  if (!secret || !Buffer.isBuffer(rawBody)) return false;
  if (typeof signatureHeader !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(signatureHeader)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(expected, received);
}

export function signGitHubPayload(secret, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
