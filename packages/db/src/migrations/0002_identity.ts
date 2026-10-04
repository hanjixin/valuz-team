import { type Kysely, sql } from "kysely";

/** Accounts and organizations — the base everything shareable hangs from. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("users")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("email", "text", (c) => c.notNull().unique())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("password_hash", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("orgs")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_by", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("org_members")
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("role", "text", (c) => c.notNull().check(sql`role IN ('owner', 'admin', 'member')`))
    .addColumn("joined_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("org_members_pkey", ["org_id", "user_id"])
    .execute();
  await db.schema.createIndex("org_members_user").on("org_members").column("user_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("org_members").execute();
  await db.schema.dropTable("orgs").execute();
  await db.schema.dropTable("users").execute();
}
