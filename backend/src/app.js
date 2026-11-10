import './database/pgTypes.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { logger, safeUrl } from './shared/logger.js';
import { loadSession, csrfProtection } from './middleware/session.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { healthRoutes } from './modules/health/routes.js';
import { githubWebhookRoutes } from './modules/github/webhookRoutes.js';
import { slackEventRoutes } from './modules/slack/eventRoutes.js';
import { authRoutes } from './modules/auth/routes.js';
import { workspaceRoutes, invitationAcceptRoutes } from './modules/workspaces/routes.js';
import { integrationRoutes, integrationCallbackRoutes } from './modules/integrations/routes.js';
import { channelRoutes, notificationRoutes } from './modules/notifications/routes.js';
import { repositoryRoutes } from './modules/repositories/routes.js';
import { eventRoutes } from './modules/events/routes.js';
import { ruleRoutes } from './modules/rules/routes.js';
import { pullRequestRoutes } from './modules/pull-requests/routes.js';
import { issueRoutes } from './modules/issues/routes.js';
import { reminderRoutes } from './modules/reminders/routes.js';
import { digestRoutes } from './modules/digests/routes.js';
import { overviewRoutes } from './modules/analytics/routes.js';

const limiter = (limit, windowMs = 60_000) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many requests' } } });

export function createApp(deps) {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.get('x-request-id')?.slice(0, 64) || randomUUID(),
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: safeUrl(req.url) }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
    }),
  );
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));

  app.use(healthRoutes(deps));

  // Webhooks: raw body + signature verification, no cookies, no CSRF, before the JSON parser.
  app.use('/api/v1/webhooks/github', limiter(3000), githubWebhookRoutes(deps));
  app.use('/api/v1/webhooks/slack', limiter(600), slackEventRoutes(deps));

  app.use('/api', cors({ origin: config.corsOrigins, credentials: true, allowedHeaders: ['Content-Type', 'X-CSRF-Token'], maxAge: 600 }));
  app.use('/api', express.json({ limit: config.jsonBodyLimit }));
  app.use('/api', cookieParser());
  app.use('/api', loadSession(deps));
  app.use('/api', csrfProtection(deps));
  app.use('/api/v1/auth', limiter(60), authRoutes(deps));
  app.use('/api/v1', limiter(600));

  app.use('/api/v1/integrations', integrationCallbackRoutes(deps));
  app.use('/api/v1/invitations', invitationAcceptRoutes(deps));
  app.use('/api/v1/workspaces', workspaceRoutes(deps));
  const scoped = (path, router) => app.use(`/api/v1/workspaces/:workspaceId${path}`, router);
  scoped('/integrations', integrationRoutes(deps));
  scoped('/channels', channelRoutes(deps));
  scoped('/notifications', notificationRoutes(deps));
  scoped('/repositories', repositoryRoutes(deps));
  scoped('', eventRoutes(deps));
  scoped('/notification-rules', ruleRoutes(deps));
  scoped('/pull-requests', pullRequestRoutes(deps));
  scoped('/issues', issueRoutes(deps));
  scoped('/reminder-policies', reminderRoutes(deps));
  scoped('/digests', digestRoutes(deps));
  scoped('/overview', overviewRoutes(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
