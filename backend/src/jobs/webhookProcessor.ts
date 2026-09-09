import db from '../lib/knex';
import { getInstallationOctokit } from '../lib/github';

export async function processWebhookJob(data: any) {
  const { event, delivery, payload } = data;

  // Idempotency check
  const exists = await db('webhook_deliveries').where({ delivery_id: delivery }).first();
  if (exists) return;

  // Mark as processed
  await db('webhook_deliveries').insert({ delivery_id: delivery, event });

  // Handle installation events
  if (event === 'installation') {
    await handleInstallationEvent(payload);
    return;
  }

  if (event === 'installation_repositories') {
    await handleInstallationRepositoriesEvent(payload);
    return;
  }

  // Handle repository events
  if (['pull_request', 'issues', 'push', 'pull_request_review'].includes(event)) {
    await handleRepositoryEvent(event, payload);
  }
}

async function handleInstallationEvent(payload: any) {
  const { action, installation } = payload;
  const installationId = installation.id;

  if (action === 'created') {
    // Store installation
    await db('installations')
      .insert({
        installation_id: installationId,
        meta: JSON.stringify(installation)
      })
      .onConflict('installation_id')
      .merge({ meta: JSON.stringify(installation) });

    // Fetch and store accessible repositories
    const octokit = await getInstallationOctokit(installationId);
    const { data } = await octokit.request('GET /installation/repositories');
    
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
  }

  if (action === 'deleted') {
    await db('installations').where({ installation_id: installationId }).del();
    await db('repositories').where({ installation_id: installationId }).update({ enabled: false });
  }
}

async function handleInstallationRepositoriesEvent(payload: any) {
  const { action, installation, repositories_added, repositories_removed } = payload;
  const installationId = installation.id;

  if (action === 'added' && repositories_added) {
    for (const repo of repositories_added) {
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
  }

  if (action === 'removed' && repositories_removed) {
    for (const repo of repositories_removed) {
      await db('repositories').where({ repo_id: repo.id }).update({ enabled: false });
    }
  }
}

async function handleRepositoryEvent(event: string, payload: any) {
  const repoId = payload.repository?.id;
  if (!repoId) return;

  const repo = await db('repositories').where({ repo_id: repoId, enabled: true }).first();
  if (!repo) return;

  // Create notification based on event type
  let notificationData: any = { repo_id: repo.id, type: event };

  switch (event) {
    case 'pull_request':
      notificationData.payload = JSON.stringify({
        action: payload.action,
        pr_number: payload.pull_request?.number,
        title: payload.pull_request?.title,
        author: payload.pull_request?.user?.login,
        url: payload.pull_request?.html_url,
        body: payload.pull_request?.body?.substring(0, 200),
        state: payload.pull_request?.state,
        commits: payload.pull_request?.commits,
        additions: payload.pull_request?.additions,
        deletions: payload.pull_request?.deletions
      });
      break;
    case 'issues':
      notificationData.payload = JSON.stringify({
        action: payload.action,
        issue_number: payload.issue?.number,
        title: payload.issue?.title,
        author: payload.issue?.user?.login,
        url: payload.issue?.html_url,
        body: payload.issue?.body?.substring(0, 200),
        state: payload.issue?.state,
        labels: payload.issue?.labels?.map(l => l.name)
      });
      break;
    case 'push':
      notificationData.payload = JSON.stringify({
        action: 'pushed',
        ref: payload.ref,
        commits_count: payload.commits?.length || 0,
        author: payload.pusher?.name,
        commits: payload.commits?.slice(0, 3).map(c => ({
          message: c.message,
          author: c.author?.name,
          url: c.url
        }))
      });
      break;
    case 'pull_request_review':
      notificationData.payload = JSON.stringify({
        action: payload.action,
        pr_number: payload.pull_request?.number,
        review_state: payload.review?.state,
        author: payload.review?.user?.login,
        body: payload.review?.body?.substring(0, 200)
      });
      break;
    default:
      notificationData.payload = JSON.stringify({ 
        action: payload.action,
        sender: payload.sender?.login
      });
  }

  await db('notifications').insert(notificationData);
}
