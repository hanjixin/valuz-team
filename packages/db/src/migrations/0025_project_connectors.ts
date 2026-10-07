import { type Kysely, sql } from "kysely";

/** The connectors a project brings to every session in it, whatever agent runs — by slug. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("projects")
    .addColumn("connectors", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("projects").dropColumn("connectors").execute();
}
