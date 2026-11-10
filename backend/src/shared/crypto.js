import crypto from 'node:crypto';

const VERSION = 'v1';

/** Random URL-safe token suitable for sessions, OAuth state, and invitations. */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two strings. Returns false for differing lengths without throwing. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function hmacSha256Hex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** AES-256-GCM authenticated encryption. Output: v1.<iv>.<tag>.<ciphertext> (base64url parts). */
export function encrypt(plaintext, key) {
  if (plaintext === undefined || plaintext === null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  const ct = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(payload, key) {
  if (!payload) return null;
  const [version, iv, tag, ct] = payload.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('Unsupported ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export function encryptJson(obj, key) {
  return encrypt(JSON.stringify(obj), key);
}

export function decryptJson(payload, key) {
  const s = decrypt(payload, key);
  return s === null ? null : JSON.parse(s);
}
