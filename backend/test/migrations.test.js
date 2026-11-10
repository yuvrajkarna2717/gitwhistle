import { describe, it, expect } from 'vitest';
import knexFactory from 'knex';
import { MIGRATIONS_DIR } from '../src/database/knex.js';

// Uses an isolated schema so rollback does not disturb the shared test schema.
describe('database migrations', () => {
  it('apply, roll back completely, and re-apply cleanly', async () => {
    const admin = knexFactory({ client: 'pg', connection: process.env.TEST_DATABASE_URL });
    await admin.raw('DROP SCHEMA IF EXISTS migration_check CASCADE');
    await admin.raw('CREATE SCHEMA migration_check');
    await admin.destroy();

    const db = knexFactory({
      client: 'pg',
      connection: process.env.TEST_DATABASE_URL,
      searchPath: ['migration_check'],
      migrations: { directory: MIGRATIONS_DIR, tableName: 'gitwhistle_migrations', schemaName: 'migration_check', loadExtensions: ['.js'] },
      pool: { min: 1, max: 1 },
    });
    try {
      // Simulate the 2025 prototype schema to prove it is preserved, not dropped.
      await db.schema.createTable('users', (t) => {
        t.increments('id');
        t.string('github_id').unique().notNullable();
        t.string('login').notNullable();
        t.string('name');
        t.string('email');
      });
      await db('users').insert({ github_id: '42', login: 'octocat' });
      await db.schema.createTable('installations', (t) => t.increments('id'));

      const [, applied] = await db.migrate.latest();
      expect(applied.length).toBe(4);
      expect(await db.schema.hasTable('legacy_users')).toBe(true);
      expect(await db.schema.hasTable('legacy_installations')).toBe(true);
      const migrated = await db('users').where({ github_id: 42 }).first();
      expect(migrated.login).toBe('octocat');

      await db.migrate.rollback(undefined, true);
      expect(await db.schema.hasTable('events')).toBe(false);
      expect(await db.schema.hasTable('users')).toBe(true); // legacy table restored
      expect(await db.schema.hasTable('legacy_users')).toBe(false);

      await db.migrate.latest();
      expect(await db.schema.hasTable('notification_deliveries')).toBe(true);
    } finally {
      await db.destroy();
      const cleanup = knexFactory({ client: 'pg', connection: process.env.TEST_DATABASE_URL });
      await cleanup.raw('DROP SCHEMA IF EXISTS migration_check CASCADE');
      await cleanup.destroy();
    }
  });
});
