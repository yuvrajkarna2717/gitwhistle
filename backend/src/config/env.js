import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const intWithDefault = (def) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intWithDefault(4000),
  WORKER_HEALTH_PORT: intWithDefault(4001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  APP_URL: z.url(),
  API_URL: optionalString.pipe(z.url().optional()),
  CORS_ORIGINS: optionalString,
  TRUST_PROXY: z.string().default('loopback'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(0),
  DATABASE_POOL_MAX: intWithDefault(10),
  REDIS_URL: z.string().min(1),

  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'must be 32 bytes encoded as base64 (generate with: openssl rand -base64 32)',
  }),

  COOKIE_SECURE: optionalString.pipe(z.enum(['true', 'false']).optional()),
  SESSION_TTL_HOURS: intWithDefault(168),
  SESSION_IDLE_HOURS: intWithDefault(72),

  GITHUB_APP_ID: optionalString,
  GITHUB_APP_SLUG: optionalString,
  GITHUB_APP_CLIENT_ID: optionalString,
  GITHUB_APP_CLIENT_SECRET: optionalString,
  GITHUB_APP_PRIVATE_KEY: optionalString,
  GITHUB_APP_PRIVATE_KEY_PATH: optionalString,
  GITHUB_APP_WEBHOOK_SECRET: optionalString,
  GITHUB_API_URL: z.url().default('https://api.github.com'),
  GITHUB_WEB_URL: z.url().default('https://github.com'),

  SLACK_CLIENT_ID: optionalString,
  SLACK_CLIENT_SECRET: optionalString,
  SLACK_SIGNING_SECRET: optionalString,
  SLACK_API_URL: optionalString,

  WEBHOOK_BODY_LIMIT: z.string().default('25mb'),
  JSON_BODY_LIMIT: z.string().default('1mb'),
  METRICS_TOKEN: optionalString,

  WORKER_EVENT_CONCURRENCY: intWithDefault(5),
  WORKER_DELIVERY_CONCURRENCY: intWithDefault(5),
  EVENT_MAX_ATTEMPTS: intWithDefault(8),
  DELIVERY_MAX_ATTEMPTS: intWithDefault(6),
  WEBHOOK_PAYLOAD_RETENTION_DAYS: intWithDefault(14),
});

function readPrivateKey(env) {
  if (env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (env.GITHUB_APP_PRIVATE_KEY_PATH) {
    const p = path.resolve(env.GITHUB_APP_PRIVATE_KEY_PATH);
    if (!fs.existsSync(p)) throw new Error(`GITHUB_APP_PRIVATE_KEY_PATH does not exist: ${p}`);
    return fs.readFileSync(p, 'utf8');
  }
  return undefined;
}

export function loadConfig(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';

  const github = {
    appId: env.GITHUB_APP_ID,
    slug: env.GITHUB_APP_SLUG,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    privateKey: readPrivateKey(env),
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
    apiUrl: env.GITHUB_API_URL.replace(/\/$/, ''),
    webUrl: env.GITHUB_WEB_URL.replace(/\/$/, ''),
  };
  github.enabled = Boolean(
    github.appId && github.slug && github.clientId && github.clientSecret && github.privateKey && github.webhookSecret,
  );

  const slack = {
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    signingSecret: env.SLACK_SIGNING_SECRET,
    apiUrl: env.SLACK_API_URL,
  };
  slack.enabled = Boolean(slack.clientId && slack.clientSecret && slack.signingSecret);

  if (isProd) {
    const missing = [];
    if (!github.enabled) missing.push('GITHUB_APP_* (all of ID, SLUG, CLIENT_ID, CLIENT_SECRET, PRIVATE_KEY[_PATH], WEBHOOK_SECRET)');
    if (!slack.enabled) missing.push('SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET');
    if (!env.API_URL) missing.push('API_URL');
    if (missing.length) throw new Error(`Missing required production configuration:\n  - ${missing.join('\n  - ')}`);
  }

  const appUrl = env.APP_URL.replace(/\/$/, '');
  const apiUrl = (env.API_URL || appUrl).replace(/\/$/, '');

  let trustProxy = env.TRUST_PROXY;
  if (/^\d+$/.test(trustProxy)) trustProxy = Number(trustProxy);
  else if (trustProxy === 'true') trustProxy = true;
  else if (trustProxy === 'false') trustProxy = false;

  // Secure cookies by default in production or over HTTPS; COOKIE_SECURE overrides (e.g. plain-HTTP local Docker).
  const secureCookies = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd || appUrl.startsWith('https://');

  return {
    env: env.NODE_ENV,
    isProd,
    isTest: env.NODE_ENV === 'test',
    port: env.PORT,
    workerHealthPort: env.WORKER_HEALTH_PORT,
    logLevel: env.LOG_LEVEL,
    appUrl,
    apiUrl,
    corsOrigins: (env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',') : [appUrl]).map((o) => o.trim()).filter(Boolean),
    trustProxy,
    database: { url: env.DATABASE_URL, poolMin: env.DATABASE_POOL_MIN, poolMax: env.DATABASE_POOL_MAX },
    redisUrl: env.REDIS_URL,
    encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'base64'),
    session: {
      // __Host- prefix: browser enforces Secure, Path=/ and no Domain attribute.
      cookieName: secureCookies ? '__Host-gw_session' : 'gw_session',
      oauthCookieName: secureCookies ? '__Host-gw_oauth' : 'gw_oauth',
      secureCookies,
      ttlHours: env.SESSION_TTL_HOURS,
      idleHours: env.SESSION_IDLE_HOURS,
    },
    github,
    slack,
    webhookBodyLimit: env.WEBHOOK_BODY_LIMIT,
    jsonBodyLimit: env.JSON_BODY_LIMIT,
    metricsToken: env.METRICS_TOKEN,
    worker: {
      eventConcurrency: env.WORKER_EVENT_CONCURRENCY,
      deliveryConcurrency: env.WORKER_DELIVERY_CONCURRENCY,
      eventMaxAttempts: env.EVENT_MAX_ATTEMPTS,
      deliveryMaxAttempts: env.DELIVERY_MAX_ATTEMPTS,
    },
    retention: { webhookPayloadDays: env.WEBHOOK_PAYLOAD_RETENTION_DAYS },
  };
}

let cached;
export function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: replace the cached configuration. */
export function setConfig(cfg) {
  cached = cfg;
}
