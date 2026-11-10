/**
 * Provider-agnostic integrations (GitHub App installations, Slack workspaces, future providers),
 * monitored repositories, and notification channels (Slack channels today).
 *
 * Composite foreign keys on (workspace_id, id) make it impossible for a row in one workspace
 * to reference a channel or repository that belongs to a different workspace.
 */
export async function up(knex) {
  await knex.schema.createTable('integrations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Nullable: a GitHub App installation webhook can arrive before a workspace claims it.
    t.uuid('workspace_id').references('workspaces.id').onDelete('CASCADE');
    t.string('provider', 32).notNullable();
    t.string('kind', 16).notNullable(); // 'source' | 'destination'
    t.string('external_id', 128).notNullable();
    t.string('status', 16).notNullable().defaultTo('active');
    t.string('display_name', 255);
    t.string('account_type', 32);
    t.jsonb('config').notNullable().defaultTo('{}');
    t.text('credentials_encrypted');
    t.uuid('connected_by').references('users.id').onDelete('SET NULL');
    t.timestamp('connected_at', { useTz: true });
    t.timestamp('disconnected_at', { useTz: true });
    t.text('last_error');
    t.timestamps(true, true);
    t.unique(['provider', 'external_id']);
    t.unique(['workspace_id', 'id']);
    t.index(['workspace_id', 'provider']);
  });
  await knex.raw(`ALTER TABLE integrations ADD CONSTRAINT integrations_status_chk
    CHECK (status IN ('pending','active','suspended','revoked','disconnected','deleted'))`);
  await knex.raw(`ALTER TABLE integrations ADD CONSTRAINT integrations_kind_chk CHECK (kind IN ('source','destination'))`);

  await knex.schema.createTable('notification_channels', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.uuid('integration_id').notNullable();
    t.string('provider', 32).notNullable();
    t.string('external_id', 128).notNullable();
    t.string('name', 255).notNullable();
    t.boolean('is_private').notNullable().defaultTo(false);
    t.boolean('is_archived').notNullable().defaultTo(false);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.unique(['integration_id', 'external_id']);
    t.unique(['workspace_id', 'id']);
    t.foreign(['workspace_id', 'integration_id']).references(['workspace_id', 'id']).inTable('integrations').onDelete('CASCADE');
  });

  await knex.schema.createTable('repositories', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').references('workspaces.id').onDelete('CASCADE');
    t.uuid('integration_id').notNullable().references('integrations.id').onDelete('CASCADE');
    t.string('provider', 32).notNullable();
    t.string('external_id', 128).notNullable();
    t.string('full_name', 255).notNullable();
    t.string('name', 255).notNullable();
    t.string('owner_login', 100);
    t.boolean('private').notNullable().defaultTo(false);
    t.boolean('archived').notNullable().defaultTo(false);
    t.boolean('disabled').notNullable().defaultTo(false);
    t.string('default_branch', 255);
    t.text('html_url');
    t.boolean('monitoring_enabled').notNullable().defaultTo(true);
    t.uuid('default_channel_id');
    t.timestamp('removed_at', { useTz: true });
    t.timestamp('synced_at', { useTz: true });
    t.timestamps(true, true);
    t.unique(['integration_id', 'external_id']);
    t.unique(['workspace_id', 'id']);
    t.index(['workspace_id', 'full_name']);
  });

  // Same-tenant channel references. ON DELETE SET NULL (column) needs PostgreSQL 15+.
  await knex.raw(`ALTER TABLE repositories ADD CONSTRAINT repositories_default_channel_fk
    FOREIGN KEY (workspace_id, default_channel_id) REFERENCES notification_channels (workspace_id, id)
    ON DELETE SET NULL (default_channel_id)`);
  await knex.raw(`ALTER TABLE workspaces ADD CONSTRAINT workspaces_default_channel_fk
    FOREIGN KEY (id, default_channel_id) REFERENCES notification_channels (workspace_id, id)
    ON DELETE SET NULL (default_channel_id)`);
  await knex.raw(`ALTER TABLE workspaces ADD CONSTRAINT workspaces_digest_channel_fk
    FOREIGN KEY (id, digest_channel_id) REFERENCES notification_channels (workspace_id, id)
    ON DELETE SET NULL (digest_channel_id)`);
}

export async function down(knex) {
  await knex.raw('ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_digest_channel_fk');
  await knex.raw('ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_default_channel_fk');
  await knex.schema.dropTableIfExists('repositories');
  await knex.schema.dropTableIfExists('notification_channels');
  await knex.schema.dropTableIfExists('integrations');
}
