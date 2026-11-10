import { generateKeyPairSync } from 'node:crypto';

// Deterministic, fake configuration. No real GitHub or Slack credentials are used by tests.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.APP_URL = 'http://localhost:5173';
process.env.API_URL = 'http://localhost:4000';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.REDIS_URL = 'redis://127.0.0.1:6399';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GITHUB_APP_ID = '12345';
process.env.GITHUB_APP_SLUG = 'gitwhistle-test';
process.env.GITHUB_APP_CLIENT_ID = 'Iv1.testclient';
process.env.GITHUB_APP_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });
process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.SLACK_CLIENT_ID = 'slack-client';
process.env.SLACK_CLIENT_SECRET = 'slack-secret';
process.env.SLACK_SIGNING_SECRET = 'slack-signing-secret';
process.env.METRICS_TOKEN = 'metrics-token';
