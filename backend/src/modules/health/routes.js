import express from 'express';
import { registry } from '../../shared/metrics.js';
import { safeEqual } from '../../shared/crypto.js';

export function healthRoutes(deps, { service = 'api' } = {}) {
  const { db, queues, config } = deps;
  const router = express.Router();

  // Liveness: the process is up and serving requests.
  router.get('/healthz', (_req, res) => res.json({ status: 'ok', service }));

  // Readiness: dependencies needed to serve traffic are reachable.
  router.get('/readyz', async (_req, res) => {
    const checks = {};
    try {
      await db.raw('select 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'unavailable';
    }
    try {
      await queues.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'unavailable';
    }
    const ready = Object.values(checks).every((v) => v === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', service, checks });
  });

  // Prometheus metrics; requires METRICS_TOKEN (Bearer) when configured, disabled otherwise.
  router.get('/metrics', async (req, res) => {
    if (!config.metricsToken) return res.status(404).end();
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(token, config.metricsToken)) return res.status(401).end();
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  return router;
}
