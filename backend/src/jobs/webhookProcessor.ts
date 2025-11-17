import db from '../lib/knex';

export async function processWebhookJob(data: any) {
  const { event, delivery, payload } = data;
  // Basic routing: store event and create notifications.
  // Keep processing minimal and idempotent: check if delivery id exists (to avoid duplicates).
  // Example: if event is 'pull_request' create a notification record

  // Example guard for idempotency
  const exists = await db('notifications').where({ 'payload->>delivery': delivery }).first();
  if (exists) return;

  if (event === 'pull_request') {
    // find repo record & insert notification for users who follow it (simplified)
    const repoFullName = payload.repository.full_name;
    const repo = await db('repositories').where({ full_name: repoFullName }).first();
    if (!repo) {
      // optionally create repo record
      await db('repositories').insert({
        repo_id: payload.repository.id,
        full_name: repoFullName,
        installation_id: null
      }).onConflict('repo_id').ignore();
    }

    // create notification
    await db('notifications').insert({
      user_id: null,
      repo_id: repo?.id || null,
      type: 'pull_request',
      payload: JSON.stringify({ delivery, action: payload.action, pr: payload.pull_request }),
      created_at: new Date()
    });
  }

  // handle other events similarly...
}
