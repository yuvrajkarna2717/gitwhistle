import express from 'express';
import db from '../lib/knex';
import { getInstallationOctokit } from '../lib/github';

const router = express.Router();

// Get all installations
router.get('/', async (req, res) => {
  try {
    const installations = await db('installations').select('*');
    res.json(installations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch installations' });
  }
});

// Get repositories for an installation
router.get('/:installationId/repositories', async (req, res) => {
  try {
    const { installationId } = req.params;
    
    // Get from database
    const repos = await db('repositories')
      .where({ installation_id: installationId })
      .select('*');
    
    res.json(repos);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch repositories' });
  }
});

// Sync repositories from GitHub API
router.post('/:installationId/sync', async (req, res) => {
  try {
    const { installationId } = req.params;
    
    const octokit = await getInstallationOctokit(installationId);
    const { data } = await octokit.request('GET /installation/repositories');
    
    // Update database with current repos
    for (const repo of data.repositories) {
      await db('repositories')
        .insert({
          repo_id: repo.id,
          full_name: repo.full_name,
          installation_id: installationId,
          enabled: true
        })
        .onConflict('repo_id')
        .merge({ installation_id: installationId, enabled: true });
    }
    
    res.json({ synced: data.repositories.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to sync repositories' });
  }
});

// Toggle repository in installation
router.post('/:installationId/repositories/:repoId', async (req, res) => {
  try {
    const { installationId, repoId } = req.params;
    
    // Update database to enable
    await db('repositories')
      .where({ repo_id: repoId })
      .update({ enabled: true, installation_id: installationId });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Add repo error:', error);
    res.status(500).json({ error: 'Failed to add repository' });
  }
});

// Remove repository from installation
router.delete('/:installationId/repositories/:repoId', async (req, res) => {
  try {
    const { repoId } = req.params;
    
    // Update database to disable
    await db('repositories').where({ repo_id: repoId }).update({ enabled: false });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Remove repo error:', error);
    res.status(500).json({ error: 'Failed to remove repository' });
  }
});

export default router;