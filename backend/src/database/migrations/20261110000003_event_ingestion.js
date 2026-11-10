/**
 * Durable webhook ingestion (also acts as the transactional outbox for event processing),
 * per-attempt processing history, and canonical (provider-neutral) events.
 */
export async function up(knex) {
  await knex.schema.createTable('webhook_deliveries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('provider', 32).notNullable();
    t.string('delivery_id', 128).notNullable();
    t.string('event_name', 64).notNullable();
    t.string('action', 64);
    t.string('installation_external_id', 128);
    t.uuid('workspace_id').references('workspaces.id').onDelete('CASCADE');
    t.uuid('integration_id').references('integrations.id').onDelete('SET NULL');
    t.jsonb('payload');
    t.integer('payload_bytes').notNullable().defaultTo(0);
    t.string('status', 16).notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
    t.text('ignore_reason');
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('enqueued_at', { useTz: true });
    t.timestamp('locked_at', { useTz: true });
    t.timestamp('processed_at', { useTz: true });
    t.timestamp('payload_purged_at', { useTz: true });
    t.unique(['provider', 'delivery_id']);
    t.index(['status', 'next_attempt_at']);
    t.index(['workspace_id', 'received_at']);
  });
  await knex.raw(`ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_status_chk
    CHECK (status IN ('pending','processing','processed','ignored','failed','dead'))`);

  await knex.schema.createTable('event_processing_attempts', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('webhook_delivery_id').notNullable().references('webhook_deliveries.id').onDelete('CASCADE');
    t.integer('attempt').notNullable();
    t.string('outcome', 16).notNullable();
    t.text('error');
    t.timestamp('started_at', { useTz: true }).notNullable();
    t.timestamp('finished_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['webhook_delivery_id']);
  });

  await knex.schema.createTable('events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.string('source', 32).notNullable();
    t.string('event_type', 96).notNullable();
    t.string('provider_event_id', 128).notNullable();
    t.uuid('webhook_delivery_id').references('webhook_deliveries.id').onDelete('SET NULL');
    t.uuid('repository_id');
    t.string('actor_login', 100);
    t.string('actor_external_id', 64);
    t.string('resource_type', 32);
    t.string('resource_external_id', 128);
    t.integer('resource_number');
    t.text('title');
    t.text('url');
    t.jsonb('metadata').notNullable().defaultTo('{}');
    t.timestamp('occurred_at', { useTz: true }).notNullable();
    t.timestamp('received_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['source', 'provider_event_id']);
    t.unique(['workspace_id', 'id']);
    t.index(['workspace_id', 'occurred_at']);
    t.index(['workspace_id', 'event_type', 'occurred_at']);
    t.index(['workspace_id', 'repository_id', 'occurred_at']);
    t.index(['workspace_id', 'actor_login']);
  });
  await knex.raw(`ALTER TABLE events ADD CONSTRAINT events_repository_fk
    FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories (workspace_id, id)
    ON DELETE SET NULL (repository_id)`);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('events');
  await knex.schema.dropTableIfExists('event_processing_attempts');
  await knex.schema.dropTableIfExists('webhook_deliveries');
}
