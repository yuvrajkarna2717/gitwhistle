import { Knex } from "knex";

export async function up(knex: Knex) {
  // await knex.schema.createTable('users', t => {
  //   t.increments('id').primary();
  //   t.string('github_id').unique().notNullable();
  //   t.string('login');
  //   t.string('name');
  //   t.string('email');
  //   t.timestamps(true, true);
  // });

  // await knex.schema.createTable('installations', t => {
  //   t.increments('id').primary();
  //   t.bigInteger('installation_id').unique().notNullable();
  //   t.integer('owner_user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
  //   t.jsonb('meta');
  //   t.timestamps(true, true);
  // });

  // await knex.schema.createTable('repositories', t => {
  //   t.increments('id').primary();
  //   t.bigInteger('repo_id').unique().notNullable();
  //   t.string('full_name').notNullable();
  //   t.integer('installation_id').unsigned().references('id').inTable('installations').onDelete('CASCADE');
  //   t.boolean('enabled').defaultTo(true);
  //   t.timestamps(true, true);
  // });

  // await knex.schema.createTable('notifications', t => {
  //   t.increments('id').primary();
  //   t.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
  //   t.integer('repo_id').unsigned().references('id').inTable('repositories').onDelete('CASCADE');
  //   t.string('type');
  //   t.jsonb('payload');
  //   t.boolean('read').defaultTo(false);
  //   t.timestamps(true, true);
  // });

  // await knex.schema.createTable('notification_rules', t => {
  //   t.increments('id').primary();
  //   t.integer('user_id').unsigned().references('id').inTable('users').onDelete('CASCADE');
  //   t.string('event_type');
  //   t.jsonb('filters');
  //   t.timestamps(true, true);
  // });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('notification_rules');
  await knex.schema.dropTableIfExists('notifications');
  await knex.schema.dropTableIfExists('repositories');
  await knex.schema.dropTableIfExists('installations');
  await knex.schema.dropTableIfExists('users');
}
