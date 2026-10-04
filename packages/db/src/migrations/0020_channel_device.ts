import type { Kysely } from "kysely";

/**
 * A bot's connection to its chat platform is held by a device — the binder's
 * own — not by the server. Null until one of the binder's devices takes it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("channel_bindings")
    .addColumn("device_id", "uuid", (c) => c.references("devices.id").onDelete("set null"))
    .execute();
  await db.schema.createIndex("channel_bindings_device").on("channel_bindings").column("device_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("channel_bindings_device").execute();
  await db.schema.alterTable("channel_bindings").dropColumn("device_id").execute();
}
