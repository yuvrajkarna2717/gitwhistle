/**
 * Starts a throwaway PostgreSQL for the test run unless TEST_DATABASE_URL is provided
 * (CI uses a service container). Migrations run once here; tests truncate between cases.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import knexFactory from 'knex';

let embedded;
let dataDir;

export async function setup() {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const port = 55000 + Math.floor(Math.random() * 2000);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-pg-'));
    embedded = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('gitwhistle_test');
    url = `postgres://postgres:postgres@127.0.0.1:${port}/gitwhistle_test`;
  }
  process.env.TEST_DATABASE_URL = url;

  const { MIGRATIONS_DIR, MIGRATIONS_TABLE } = await import('../src/database/knex.js');
  const db = knexFactory({
    client: 'pg',
    connection: url,
    migrations: { directory: MIGRATIONS_DIR, tableName: MIGRATIONS_TABLE, loadExtensions: ['.js'] },
  });
  await db.migrate.latest();
  await db.destroy();

  return async () => {
    if (embedded) await embedded.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  };
}
