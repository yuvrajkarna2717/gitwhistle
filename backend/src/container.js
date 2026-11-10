import { getConfig } from './config/env.js';
import { getDb } from './database/knex.js';
import { createQueues } from './queues/index.js';
import { createGitHubClient } from './modules/github/client.js';
import { createSlackClient } from './modules/slack/client.js';
import { createRegistry } from './modules/integrations/registry.js';

/**
 * Dependency container. Everything with I/O (database, Redis, GitHub, Slack) is created here and
 * passed explicitly, so tests can replace any of it.
 */
export function createContainer(overrides = {}) {
  const config = overrides.config ?? getConfig();
  const db = overrides.db ?? getDb();
  const queues = overrides.queues ?? createQueues(config);
  const github = overrides.github ?? createGitHubClient(config);
  const slack = overrides.slack ?? createSlackClient(config);
  const registry = overrides.registry ?? createRegistry({ config, slack });
  return { config, db, queues, github, slack, registry };
}
