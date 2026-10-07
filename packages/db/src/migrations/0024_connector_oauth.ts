import type { Kysely } from "kysely";

/**
 * A connector whose server asks for an OAuth sign-in: who the server is to the
 * authorization server (the registered client), where to send people and
 * exchange codes, and — once someone has signed in — the tokens. Sealed, like
 * every other credential.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("connectors").addColumn("oauth_enc", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("connectors").dropColumn("oauth_enc").execute();
}
