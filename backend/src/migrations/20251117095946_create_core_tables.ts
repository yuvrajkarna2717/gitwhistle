import { Knex } from "knex";

export async function up(knex: Knex) {
  return knex.schema.createTable("users", (table) => {
    table.increments("id").primary();
    table.string("github_id").unique().notNullable();
    table.string("login").notNullable();
    table.string("name");
    table.string("email");
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists("users");
}
