/**
 * Notification rules, notification deliveries (outbox for outbound messages),
 * pull request / review / issue state, reminder policies, and daily digests.
 */
export async function up(knex) {
  await knex.schema.createTable('notification_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.text('description');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('priority').notNullable().defaultTo(100);
    t.string('match_mode', 8).notNullable().defaultTo('all');
    t.jsonb('conditions').notNullable().defaultTo('[]');
    t.jsonb('actions').notNullable();
    t.uuid('created_by').references('users.id').onDelete('SET NULL');
    t.uuid('updated_by').references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['workspace_id', 'enabled', 'priority']);
  });
  await knex.raw(`ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_match_chk CHECK (match_mode IN ('all','any'))`);

  await knex.schema.createTable('notification_deliveries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.string('kind', 16).notNullable(); // event | reminder | digest
    t.uuid('event_id');
    t.uuid('channel_id').notNullable();
    t.string('provider', 32).notNullable();
    // Deterministic key: identical inputs (e.g. a redelivered webhook) can never create a second row.
    t.string('dedupe_key', 255).notNullable().unique();
    t.string('status', 16).notNullable().defaultTo('pending');
    t.string('priority', 8).notNullable().defaultTo('normal');
    t.jsonb('rule_ids').notNullable().defaultTo('[]');
    t.jsonb('message').notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
    t.string('external_message_id', 128);
    t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('enqueued_at', { useTz: true });
    t.timestamp('locked_at', { useTz: true });
    t.timestamp('sent_at', { useTz: true });
    t.timestamps(true, true);
    t.index(['workspace_id', 'created_at']);
    t.index(['status', 'next_attempt_at']);
    t.index(['event_id']);
  });
  await knex.raw(`ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_chk
    CHECK (status IN ('pending','sending','sent','failed','dead','skipped'))`);
  await knex.raw(`ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_fk
    FOREIGN KEY (workspace_id, channel_id) REFERENCES notification_channels (workspace_id, id) ON DELETE CASCADE`);
  await knex.raw(`ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_event_fk
    FOREIGN KEY (workspace_id, event_id) REFERENCES events (workspace_id, id) ON DELETE SET NULL (event_id)`);

  await knex.schema.createTable('pull_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.uuid('repository_id').notNullable();
    t.string('external_id', 64).notNullable();
    t.integer('number').notNullable();
    t.text('title').notNullable();
    t.string('author_login', 100);
    t.string('state', 16).notNullable();
    t.boolean('draft').notNullable().defaultTo(false);
    t.boolean('merged').notNullable().defaultTo(false);
    t.string('merged_by', 100);
    t.timestamp('merged_at', { useTz: true });
    t.timestamp('closed_at', { useTz: true });
    t.string('base_ref', 255);
    t.string('head_ref', 255);
    t.string('head_sha', 64);
    t.text('html_url');
    t.jsonb('requested_reviewers').notNullable().defaultTo('[]');
    t.jsonb('requested_teams').notNullable().defaultTo('[]');
    t.string('review_state', 24).notNullable().defaultTo('none');
    t.integer('additions');
    t.integer('deletions');
    t.timestamp('last_review_at', { useTz: true });
    t.timestamp('last_commit_at', { useTz: true });
    t.timestamp('last_activity_at', { useTz: true }).notNullable();
    t.timestamp('review_requested_at', { useTz: true });
    t.timestamp('gh_created_at', { useTz: true }).notNullable();
    t.timestamp('gh_updated_at', { useTz: true }).notNullable();
    t.timestamp('synced_at', { useTz: true });
    t.timestamps(true, true);
    t.unique(['repository_id', 'number']);
    t.unique(['workspace_id', 'id']);
    t.index(['workspace_id', 'state', 'last_activity_at']);
  });
  await knex.raw(`ALTER TABLE pull_requests ADD CONSTRAINT pull_requests_repository_fk
    FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories (workspace_id, id) ON DELETE CASCADE`);

  await knex.schema.createTable('pull_request_reviews', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.uuid('pull_request_id').notNullable();
    t.string('external_id', 64).notNullable();
    t.string('reviewer_login', 100);
    t.string('state', 24).notNullable();
    t.string('commit_id', 64);
    t.timestamp('submitted_at', { useTz: true });
    t.timestamps(true, true);
    t.unique(['pull_request_id', 'external_id']);
  });
  await knex.raw(`ALTER TABLE pull_request_reviews ADD CONSTRAINT pull_request_reviews_pr_fk
    FOREIGN KEY (workspace_id, pull_request_id) REFERENCES pull_requests (workspace_id, id) ON DELETE CASCADE`);

  await knex.schema.createTable('issues', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.uuid('repository_id').notNullable();
    t.string('external_id', 64).notNullable();
    t.integer('number').notNullable();
    t.text('title').notNullable();
    t.string('author_login', 100);
    t.string('state', 16).notNullable();
    t.string('state_reason', 32);
    t.jsonb('assignees').notNullable().defaultTo('[]');
    t.jsonb('labels').notNullable().defaultTo('[]');
    t.text('html_url');
    t.integer('comments_count').notNullable().defaultTo(0);
    t.timestamp('gh_created_at', { useTz: true }).notNullable();
    t.timestamp('gh_updated_at', { useTz: true }).notNullable();
    t.timestamp('closed_at', { useTz: true });
    t.timestamp('last_activity_at', { useTz: true }).notNullable();
    t.timestamps(true, true);
    t.unique(['repository_id', 'number']);
    t.index(['workspace_id', 'state', 'last_activity_at']);
  });
  await knex.raw(`ALTER TABLE issues ADD CONSTRAINT issues_repository_fk
    FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories (workspace_id, id) ON DELETE CASCADE`);

  await knex.schema.createTable('reminder_policies', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.string('type', 32).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('threshold_hours').notNullable();
    t.integer('repeat_hours');
    t.uuid('channel_id');
    t.timestamps(true, true);
    t.unique(['workspace_id', 'type']);
  });
  await knex.raw(`ALTER TABLE reminder_policies ADD CONSTRAINT reminder_policies_type_chk
    CHECK (type IN ('review_pending','stale_pr','changes_requested'))`);
  await knex.raw(`ALTER TABLE reminder_policies ADD CONSTRAINT reminder_policies_threshold_chk
    CHECK (threshold_hours BETWEEN 1 AND 2160 AND (repeat_hours IS NULL OR repeat_hours BETWEEN 1 AND 2160))`);
  await knex.raw(`ALTER TABLE reminder_policies ADD CONSTRAINT reminder_policies_channel_fk
    FOREIGN KEY (workspace_id, channel_id) REFERENCES notification_channels (workspace_id, id)
    ON DELETE SET NULL (channel_id)`);

  await knex.schema.createTable('daily_digests', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('workspace_id').notNullable().references('workspaces.id').onDelete('CASCADE');
    t.date('digest_date').notNullable();
    t.timestamp('window_start', { useTz: true }).notNullable();
    t.timestamp('window_end', { useTz: true }).notNullable();
    t.string('status', 16).notNullable().defaultTo('pending');
    t.jsonb('summary');
    t.uuid('delivery_id').references('notification_deliveries.id').onDelete('SET NULL');
    t.text('last_error');
    t.timestamps(true, true);
    t.unique(['workspace_id', 'digest_date']);
  });
  await knex.raw(`ALTER TABLE daily_digests ADD CONSTRAINT daily_digests_status_chk
    CHECK (status IN ('pending','queued','skipped','failed'))`);
}

export async function down(knex) {
  for (const t of [
    'daily_digests',
    'reminder_policies',
    'issues',
    'pull_request_reviews',
    'pull_requests',
    'notification_deliveries',
    'notification_rules',
  ]) {
    await knex.schema.dropTableIfExists(t);
  }
}
