import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knexFactory from 'knex';
import './pgTypes.js';
import { getConfig } from '../config/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(here, 'migrations');
export const MIGRATIONS_TABLE = 'gitwhistle_migrations';

export function knexConfig(cfg = getConfig()) {
  return {
    client: 'pg',
    connection: cfg.database.url,
    pool: { min: cfg.database.poolMin, max: cfg.database.poolMax },
    migrations: {
      directory: MIGRATIONS_DIR,
      tableName: MIGRATIONS_TABLE,
      loadExtensions: ['.js'],
    },
  };
}

let instance;

export function getDb() {
  if (!instance) instance = knexFactory(knexConfig());
  return instance;
}

export function setDb(db) {
  instance = db;
}

export async function closeDb() {
  if (instance) {
    await instance.destroy();
    instance = undefined;
  }
}
