#!/usr/bin/env node
// Usage: node src/database/migrate.js [latest|rollback|status|down-all]
import knexFactory from 'knex';
import { knexConfig } from './knex.js';
import { logger } from '../shared/logger.js';

const command = process.argv[2] || 'latest';
const db = knexFactory(knexConfig());

try {
  if (command === 'latest') {
    const [batch, files] = await db.migrate.latest();
    logger.info({ batch, files }, files.length ? 'Migrations applied' : 'Database already up to date');
  } else if (command === 'rollback') {
    const [batch, files] = await db.migrate.rollback();
    logger.info({ batch, files }, 'Rolled back last batch');
  } else if (command === 'down-all') {
    const [, files] = await db.migrate.rollback(undefined, true);
    logger.info({ files }, 'Rolled back all migrations');
  } else if (command === 'status') {
    const [done, pending] = await db.migrate.list();
    logger.info({ completed: done.map((d) => d.name), pending: pending.map((p) => p.file) }, 'Migration status');
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (err) {
  logger.error({ err }, 'Migration command failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}
