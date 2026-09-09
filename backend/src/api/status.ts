import express from 'express';
import db from '../lib/knex';

const router = express.Router();

// Get GitHub App installation status
router.get('/github-app', async (req, res) => {
  try {
    const installations = await db('installations').count('* as count').first();
    const repositories = await db('repositories').where({ enabled: true }).count('* as count').first();
    const webhookDeliveries = await db('webhook_deliveries').count('* as count').first();
    
    res.json({
      installations: installations?.count || 0,
      repositories: repositories?.count || 0,
      webhookDeliveries: webhookDeliveries?.count || 0,
      appId: process.env.GITHUB_APP_ID,
      webhookConfigured: !!process.env.GITHUB_APP_WEBHOOK_SECRET
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

export default router;