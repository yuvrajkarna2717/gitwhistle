/**
 * Core identity, sessions, OAuth state, workspaces (tenants), membership, invitations, audit log.
 *
 * The 2025 prototype created integer-keyed tables (users, installations, repositories,
 * webhook_deliveries, notifications) tracked in the old `knex_migrations` table. Those tables
 * are renamed to legacy_* here instead of being dropped, and prototype users are copied over.
 */
const LEGACY_TABLES = ['users', 'installations', 'repositories', 'webhook_deliveries', 'notifications'];

async function isLegacyUsers(knex) {
  const row = await knex('information_schema.columns')
    .where({ table_schema: knex.raw('current_schema()'), table_name: 'users', column_name: 'id' })
    .first('data_type');
  return row && row.data_type === 'integer';
}

// Index and constraint names survive a table rename, so they must be renamed too
// or the new tables' constraints (e.g. users_pkey) would collide.
async function renameIndexes(knex, table, from, to) {
  const { rows } = await knex.raw(
    'SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?',
    [table],
  );
  for (const { indexname } of rows) {
    if (!indexname.startsWith(from)) continue;
    await knex.raw('ALTER INDEX ?? RENAME TO ??', [indexname, to + indexname.slice(from.length)]);
  }
}

export async function up(knex) {
  const hasLegacyUsers = (await knex.schema.hasTable('users')) && (await isLegacyUsers(knex));
  for (const t of LEGACY_TABLES) {
    if (t === 'users' && !hasLegacyUsers) continue;
    if ((await knex.schema.hasTable(t)) && !(await knex.schema.hasTable(`legacy_${t}`))) {
      await knex.schema.renameTable(t, `legacy_${t}`);
      await renameIndexes(knex, `legacy_${t}`, t, `legacy_${t}`);
    }
  }

  await knex.schema.createTable('users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.bigInteger('github_id').notNullable().unique();
    t.string('login', 100).notNullable();
    t.string('name', 255);
    t.string('email', 320);
    t.text('avatar_url');
    t.timestamp('last_login_at', { useTz: true });
    t.timestamps(true, true);
  });

  if (hasLegacyUsers) {
    await knex.raw(`
      INSERT INTO users (github_id, login, name, email)
      SELECT github_id::bigint, login, name, email FROM legacy_users
      WHERE github_id ~ '^[0-9]+$'
      ON CONFLICT (github_id) DO NOTHING`);
  }

  await knex.schema.createTable('sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.string('csrf_token', 64).notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.string('ip', 64);
    t.string('user_agent', 512);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['user_id']);
    t.index(['expires_at']);
  });

  await knex.schema.createTable('workspaces', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 100).notNullable();
    t.string('slug', 60).notNullable().unique();
    t.string('timezone', 64).notNullable().defaultTo('UTC');
    t.boolean('fallback_routing_enabled').notNullable().defaultTo(true);
    t.boolean('digest_enabled').notNullable().defaultTo(false);
    t.smallint('digest_hour').notNullable().defaultTo(9);
    t.uuid('default_channel_id');
    t.uuid('digest_channel_id');
    t.uuid('created_by').references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await knex.raw('ALTER TABLE workspaces ADD CONSTRAINT workspaces_digest_hour_chk CHECK (digest_hour BETWEEN 0 AND 23)');

  await knex.schema.createTable('workspace_members', (t) => {
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.string('role', 16).notNullable();
    t.timestamps(true, true);
    t.primary(['workspace_id', 'user_id']);
    t.index(['user_id']);
  });
  await knex.raw(
    "ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_chk CHECK (role IN ('owner','admin','member'))",
  );

  await knex.schema.createTable('workspace_invitations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.string('role', 16).notNullable();
    t.string('github_login', 100);
    t.uuid('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('accepted_at', { useTz: true });
    t.uuid('accepted_by').references('users.id').onDelete('SET NULL');
    t.timestamp('revoked_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['workspace_id']);
  });
  await knex.raw(
    "ALTER TABLE workspace_invitations ADD CONSTRAINT workspace_invitations_role_chk CHECK (role IN ('admin','member'))",
  );

  await knex.schema.createTable('oauth_states', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('state_hash', 64).notNullable().unique();
    t.string('purpose', 32).notNullable();
    t.string('browser_binding_hash', 64);
    t.uuid('session_id').references('sessions.id').onDelete('CASCADE');
    t.uuid('user_id').references('users.id').onDelete('CASCADE');
    t.uuid('workspace_id').references('workspaces.id').onDelete('CASCADE');
    t.jsonb('data').notNullable().defaultTo('{}');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('consumed_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['expires_at']);
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('workspace_id').references('workspaces.id').onDelete('CASCADE');
    t.uuid('actor_user_id').references('users.id').onDelete('SET NULL');
    t.string('action', 64).notNullable();
    t.string('target_type', 64);
    t.string('target_id', 128);
    t.jsonb('metadata').notNullable().defaultTo('{}');
    t.string('ip', 64);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['workspace_id', 'created_at']);
  });
}

export async function down(knex) {
  for (const t of ['audit_logs', 'oauth_states', 'workspace_invitations', 'workspace_members', 'workspaces', 'sessions', 'users']) {
    await knex.schema.dropTableIfExists(t);
  }
  for (const t of LEGACY_TABLES) {
    if ((await knex.schema.hasTable(`legacy_${t}`)) && !(await knex.schema.hasTable(t))) {
      await knex.schema.renameTable(`legacy_${t}`, t);
      await renameIndexes(knex, t, `legacy_${t}`, t);
    }
  }
}
