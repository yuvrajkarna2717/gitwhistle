import { badRequest, conflict, forbidden } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { logger, errSummary } from '../../shared/logger.js';
import { missingPermissions, REQUIRED_EVENT_SUBSCRIPTIONS } from './adapter.js';
import { upsertPullRequest, upsertReview, refreshReviewSummary, upsertIssue } from './projections.js';

const MAX_BACKFILL_PRS = 200;
const MAX_REVIEW_FETCHES = 50;

export function installationConfig(inst) {
  const granted = inst.permissions || {};
  const events = inst.events || [];
  return {
    accountLogin: inst.account?.login ?? null,
    accountId: inst.account?.id ?? null,
    accountType: inst.account?.type ?? null,
    repositorySelection: inst.repository_selection ?? null,
    permissions: granted,
    events,
    missingPermissions: missingPermissions(granted),
    missingEvents: REQUIRED_EVENT_SUBSCRIPTIONS.filter((e) => !events.includes(e)),
    htmlUrl: inst.html_url ?? null,
  };
}

function statusFor(inst) {
  return inst.suspended_at ? 'suspended' : 'active';
}

function repoRow(repo, { integrationId, workspaceId }) {
  return {
    workspace_id: workspaceId,
    integration_id: integrationId,
    provider: 'github',
    external_id: String(repo.id),
    full_name: repo.full_name,
    name: repo.name ?? repo.full_name.split('/')[1],
    owner_login: repo.owner?.login ?? repo.full_name.split('/')[0],
    private: Boolean(repo.private),
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
    default_branch: repo.default_branch ?? null,
    html_url: repo.html_url ?? `https://github.com/${repo.full_name}`,
    removed_at: null,
    synced_at: new Date(),
  };
}

/** Upsert repositories; returns ids of rows that were newly created or re-added. */
export async function upsertRepositories(trx, integration, repos) {
  const added = [];
  for (const repo of repos) {
    const row = repoRow(repo, { integrationId: integration.id, workspaceId: integration.workspace_id });
    const previous = await trx('repositories').where({ integration_id: integration.id, external_id: row.external_id }).first('id', 'removed_at');
    // Partial payloads (installation_repositories) omit some fields; keep stored values then.
    const mergeCols = ['workspace_id', 'full_name', 'name', 'owner_login', 'private', 'removed_at', 'synced_at', 'updated_at'];
    if (repo.archived !== undefined) mergeCols.push('archived');
    if (repo.disabled !== undefined) mergeCols.push('disabled');
    if (repo.default_branch) mergeCols.push('default_branch');
    if (repo.html_url) mergeCols.push('html_url');
    const [saved] = await trx('repositories')
      .insert({ ...row, monitoring_enabled: !repo.archived })
      .onConflict(['integration_id', 'external_id'])
      .merge(mergeCols)
      .returning(['id']);
    if (!previous || previous.removed_at) added.push(saved.id);
  }
  return added;
}

async function markRepositoriesRemoved(trx, integrationId, externalIds) {
  if (!externalIds.length) return 0;
  return trx('repositories')
    .where({ integration_id: integrationId })
    .whereIn('external_id', externalIds.map(String))
    .whereNull('removed_at')
    .update({ removed_at: trx.fn.now(), updated_at: trx.fn.now() });
}

/**
 * Handles installation lifecycle webhooks inside the processing transaction.
 * Returns follow-up tasks to enqueue after commit.
 */
export async function handleInstallationWebhook(trx, deps, { eventName, payload }) {
  const inst = payload.installation;
  const externalId = String(inst.id);
  const tasks = [];
  const existing = await trx('integrations').where({ provider: 'github', external_id: externalId }).first();

  if (eventName === 'installation') {
    const action = payload.action;
    if (action === 'created' || action === 'new_permissions_accepted' || action === 'unsuspend' || action === 'suspend') {
      const status = action === 'suspend' ? 'suspended' : action === 'unsuspend' ? 'active' : statusFor(inst);
      const row = {
        provider: 'github',
        kind: 'source',
        external_id: externalId,
        status,
        display_name: inst.account?.login ?? null,
        account_type: inst.account?.type ?? null,
        config: installationConfig(inst),
        updated_at: trx.fn.now(),
      };
      let integration;
      if (existing) {
        // A deleted installation id is never reused by GitHub, but keep the row's workspace link.
        [integration] = await trx('integrations').where({ id: existing.id }).update(row).returning('*');
      } else {
        [integration] = await trx('integrations').insert(row).returning('*');
      }
      if (action === 'created' && Array.isArray(payload.repositories)) {
        await upsertRepositories(trx, integration, payload.repositories);
      }
      if (action === 'suspend' || action === 'unsuspend') deps.github.forgetInstallation?.(externalId);
      if (integration.workspace_id && status === 'active') tasks.push({ name: 'sync-installation', data: { integrationId: integration.id } });
      return { tasks, workspaceId: integration.workspace_id, integrationId: integration.id };
    }
    if (action === 'deleted') {
      if (!existing) return { tasks, ignoredReason: 'unknown installation deleted' };
      await trx('integrations')
        .where({ id: existing.id })
        .update({ status: 'deleted', disconnected_at: trx.fn.now(), updated_at: trx.fn.now() });
      await trx('repositories')
        .where({ integration_id: existing.id })
        .whereNull('removed_at')
        .update({ removed_at: trx.fn.now(), updated_at: trx.fn.now() });
      deps.github.forgetInstallation?.(externalId);
      return { tasks, workspaceId: existing.workspace_id, integrationId: existing.id };
    }
    return { tasks, ignoredReason: `installation.${action} not handled` };
  }

  if (eventName === 'installation_repositories') {
    if (!existing) return { tasks, ignoredReason: 'installation not yet known' };
    const added = await upsertRepositories(trx, existing, payload.repositories_added || []);
    await markRepositoriesRemoved(trx, existing.id, (payload.repositories_removed || []).map((r) => r.id));
    await trx('integrations')
      .where({ id: existing.id })
      .update({ config: { ...existing.config, repositorySelection: payload.repository_selection ?? existing.config.repositorySelection }, updated_at: trx.fn.now() });
    if (existing.workspace_id) for (const id of added) tasks.push({ name: 'sync-repository', data: { repositoryId: id } });
    return { tasks, workspaceId: existing.workspace_id, integrationId: existing.id };
  }

  if (eventName === 'repository') {
    if (!existing) return { tasks, ignoredReason: 'installation not yet known' };
    const repo = payload.repository;
    if (payload.action === 'deleted' || payload.action === 'transferred') {
      await markRepositoriesRemoved(trx, existing.id, [repo.id]);
    } else {
      await upsertRepositories(trx, existing, [repo]);
    }
    return { tasks, workspaceId: existing.workspace_id, integrationId: existing.id };
  }

  return { tasks, ignoredReason: `${eventName} not handled` };
}

/**
 * Links a GitHub App installation to a workspace after proving the signed-in user can access it
 * (via GET /user/installations with their own user token).
 */
export async function completeInstallationClaim(deps, req, { workspaceId, installationId, accessibleInstallationIds }) {
  const { db, github, queues } = deps;
  if (!/^\d+$/.test(String(installationId))) throw badRequest('Invalid installation id');
  if (!accessibleInstallationIds.map(String).includes(String(installationId))) {
    throw forbidden('Your GitHub account does not have access to that installation');
  }
  const membership = await db('workspace_members').where({ workspace_id: workspaceId, user_id: req.user.id }).first('role');
  if (!membership || membership.role === 'member') throw forbidden('Only workspace admins can connect GitHub');

  const inst = await github.getInstallation(installationId);
  const integration = await db.transaction(async (trx) => {
    const existing = await trx('integrations').where({ provider: 'github', external_id: String(installationId) }).forUpdate().first();
    const ownedElsewhere = existing?.workspace_id && existing.workspace_id !== workspaceId;
    if (ownedElsewhere && !['deleted', 'disconnected'].includes(existing.status)) {
      const err = conflict('This GitHub installation is already connected to another workspace');
      err.code = 'installation_claimed';
      throw err;
    }
    if (ownedElsewhere) {
      // Hand-over from a workspace that disconnected it: that workspace's repo/PR/issue rows go
      // with it (its events keep their history, minus the repository link).
      await trx('repositories').where({ integration_id: existing.id }).del();
    }
    const row = {
      workspace_id: workspaceId,
      provider: 'github',
      kind: 'source',
      external_id: String(installationId),
      status: statusFor(inst),
      display_name: inst.account?.login ?? null,
      account_type: inst.account?.type ?? null,
      config: installationConfig(inst),
      connected_by: req.user.id,
      connected_at: trx.fn.now(),
      disconnected_at: null,
      updated_at: trx.fn.now(),
    };
    const [saved] = existing
      ? await trx('integrations').where({ id: existing.id }).update(row).returning('*')
      : await trx('integrations').insert(row).returning('*');
    await trx('repositories').where({ integration_id: saved.id }).update({ workspace_id: workspaceId });
    return saved;
  });

  await audit(db, req, {
    workspaceId,
    action: 'integration.github.connected',
    targetType: 'integration',
    targetId: integration.id,
    metadata: { account: integration.display_name, installationId: String(installationId) },
  });
  await queues.enqueueTask('sync-installation', { integrationId: integration.id }).catch((err) =>
    logger.warn({ err: errSummary(err) }, 'Could not enqueue installation sync; it can be triggered manually'),
  );
  return integration;
}

/** Full repository sync for an installation, with pagination; repos no longer accessible are marked removed. */
export async function syncInstallation(deps, integrationId) {
  const { db, github, queues } = deps;
  const integration = await db('integrations').where({ id: integrationId, provider: 'github' }).first();
  if (!integration || integration.status !== 'active') return { skipped: true };

  const [inst, repos] = await Promise.all([
    github.getInstallation(integration.external_id),
    github.listInstallationRepositories(integration.external_id),
  ]);
  const added = await db.transaction(async (trx) => {
    await trx('integrations')
      .where({ id: integration.id })
      .update({ config: installationConfig(inst), status: statusFor(inst), last_error: null, updated_at: trx.fn.now() });
    const newIds = await upsertRepositories(trx, integration, repos);
    const seen = new Set(repos.map((r) => String(r.id)));
    const stored = await trx('repositories').where({ integration_id: integration.id }).whereNull('removed_at').select('external_id');
    await markRepositoriesRemoved(trx, integration.id, stored.map((r) => r.external_id).filter((id) => !seen.has(id)));
    return newIds;
  });

  if (integration.workspace_id) {
    const monitored = await db('repositories')
      .where({ integration_id: integration.id, monitoring_enabled: true, archived: false })
      .whereNull('removed_at')
      .whereIn('id', added)
      .select('id');
    for (const r of monitored) await queues.enqueueTask('sync-repository', { repositoryId: r.id });
  }
  return { repositories: repos.length, added: added.length };
}

/**
 * Backfills authoritative open PR and issue state for a repository, and reconciles PRs we think are
 * open but GitHub no longer lists (closed or merged while we were not receiving events).
 */
export async function syncRepository(deps, repositoryId) {
  const { db, github } = deps;
  const repo = await db('repositories as r')
    .join('integrations as i', 'i.id', 'r.integration_id')
    .where('r.id', repositoryId)
    .first('r.*', 'i.external_id as installation_id', 'i.status as integration_status');
  if (!repo || !repo.workspace_id || repo.integration_status !== 'active' || repo.removed_at || !repo.monitoring_enabled) {
    return { skipped: true };
  }
  const [owner, name] = repo.full_name.split('/');
  const openPrs = (await github.listOpenPullRequests(repo.installation_id, owner, name)).slice(0, MAX_BACKFILL_PRS);
  const openIssues = await github.listOpenIssues(repo.installation_id, owner, name);

  const reviewsByPr = new Map();
  for (const pr of openPrs.slice(0, MAX_REVIEW_FETCHES)) {
    reviewsByPr.set(pr.number, await github.listPullRequestReviews(repo.installation_id, owner, name, pr.number));
  }

  const openNumbers = new Set(openPrs.map((p) => p.number));
  const staleOpen = await db('pull_requests').where({ repository_id: repo.id, state: 'open' }).select('number');
  const reconciled = [];
  for (const { number } of staleOpen) {
    if (!openNumbers.has(number)) reconciled.push(await github.getPullRequest(repo.installation_id, owner, name, number));
  }

  await db.transaction(async (trx) => {
    for (const pr of [...openPrs, ...reconciled]) {
      const prId = await upsertPullRequest(trx, { workspaceId: repo.workspace_id, repositoryId: repo.id, pr });
      const reviews = reviewsByPr.get(pr.number);
      if (reviews) {
        for (const review of reviews) await upsertReview(trx, { workspaceId: repo.workspace_id, pullRequestId: prId, review });
        await refreshReviewSummary(trx, prId);
      }
      await trx('pull_requests').where({ id: prId }).update({ synced_at: trx.fn.now() });
    }
    for (const issue of openIssues) await upsertIssue(trx, { workspaceId: repo.workspace_id, repositoryId: repo.id, issue });
    await trx('repositories').where({ id: repo.id }).update({ synced_at: trx.fn.now() });
  });
  return { pullRequests: openPrs.length, reconciled: reconciled.length, issues: openIssues.length };
}

/** Re-reads a single PR (and its reviews) from GitHub. Used before sending reminders. */
export async function refreshPullRequestFromGitHub(deps, pullRequestId) {
  const { db, github } = deps;
  const pr = await db('pull_requests as p')
    .join('repositories as r', 'r.id', 'p.repository_id')
    .join('integrations as i', 'i.id', 'r.integration_id')
    .where('p.id', pullRequestId)
    .first('p.*', 'r.full_name', 'i.external_id as installation_id', 'i.status as integration_status');
  if (!pr || pr.integration_status !== 'active') return null;
  const [owner, name] = pr.full_name.split('/');
  const [fresh, reviews] = await Promise.all([
    github.getPullRequest(pr.installation_id, owner, name, pr.number),
    github.listPullRequestReviews(pr.installation_id, owner, name, pr.number),
  ]);
  await db.transaction(async (trx) => {
    await upsertPullRequest(trx, { workspaceId: pr.workspace_id, repositoryId: pr.repository_id, pr: fresh });
    for (const review of reviews) await upsertReview(trx, { workspaceId: pr.workspace_id, pullRequestId: pr.id, review });
    await refreshReviewSummary(trx, pr.id);
    await trx('pull_requests').where({ id: pr.id }).update({ synced_at: trx.fn.now() });
  });
  return db('pull_requests').where({ id: pr.id }).first();
}
