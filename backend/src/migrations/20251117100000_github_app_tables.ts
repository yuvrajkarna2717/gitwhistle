import { Knex } from "knex";

export async function up(knex: Knex) {
  // Installations table
  await knex.schema.createTable("installations", (table) => {
    table.increments("id").primary();
    table.bigInteger("installation_id").unique().notNullable();
    table.json("meta").notNullable();
    table.timestamps(true, true);
  });

  // Repositories table
  await knex.schema.createTable("repositories", (table) => {
    table.increments("id").primary();
    table.bigInteger("repo_id").unique().notNullable();
    table.string("full_name").notNullable();
    table.bigInteger("installation_id").nullable();
    table.boolean("enabled").defaultTo(true);
    table.timestamps(true, true);
    table.index("installation_id");
  });

  // Webhook deliveries for idempotency
  await knex.schema.createTable("webhook_deliveries", (table) => {
    table.increments("id").primary();
    table.string("delivery_id").unique().notNullable();
    table.string("event").notNullable();
    table.timestamp("processed_at").defaultTo(knex.fn.now());
  });

  // Notifications table (if not exists)
  const hasNotifications = await knex.schema.hasTable("notifications");
  if (!hasNotifications) {
    await knex.schema.createTable("notifications", (table) => {
      table.increments("id").primary();
      table.integer("user_id").nullable();
      table.integer("repo_id").nullable();
      table.string("type").notNullable();
      table.json("payload").notNullable();
      table.timestamps(true, true);
    });
  }
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists("webhook_deliveries");
  await knex.schema.dropTableIfExists("repositories");
  await knex.schema.dropTableIfExists("installations");
}