import { type Kysely, sql } from "kysely";

/** Invites, teams, the share ladder, and the audit trail. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const now = sql`now()`;
  await db.schema
    .createTable("org_invites")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("email", "text", (c) => c.notNull())
    .addColumn("role", "text", (c) => c.notNull().check(sql`role IN ('admin', 'member')`))
    .addColumn("token_hash", "text", (c) => c.notNull().unique())
    .addColumn("invited_by", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("accepted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("org_invites_org").on("org_invites").column("org_id").execute();

  await db.schema
    .createTable("teams")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addUniqueConstraint("teams_org_name", ["org_id", "name"])
    .execute();

  await db.schema
    .createTable("team_members")
    .addColumn("team_id", "uuid", (c) => c.notNull().references("teams.id").onDelete("cascade"))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addPrimaryKeyConstraint("team_members_pkey", ["team_id", "user_id"])
    .execute();
  await db.schema.createIndex("team_members_user").on("team_members").column("user_id").execute();

  // One share ladder for every shareable resource; `rank` orders the permissions.
  await db.schema
    .createTable("resource_shares")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("resource_type", "text", (c) => c.notNull())
    .addColumn("resource_id", "uuid", (c) => c.notNull())
    .addColumn("principal_type", "text", (c) => c.notNull().check(sql`principal_type IN ('org', 'team', 'user')`))
    .addColumn("principal_id", "uuid", (c) => c.notNull())
    .addColumn("permission", "text", (c) => c.notNull().check(sql`permission IN ('view', 'use', 'edit', 'control')`))
    .addColumn("rank", "int2", (c) => c.notNull())
    .addColumn("created_by", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .addUniqueConstraint("resource_shares_unique", ["resource_type", "resource_id", "principal_type", "principal_id"])
    .execute();
  await db.schema
    .createIndex("resource_shares_principal")
    .on("resource_shares")
    .columns(["principal_type", "principal_id"])
    .execute();

  await db.schema
    .createTable("audit_logs")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("org_id", "uuid", (c) => c.notNull().references("orgs.id").onDelete("cascade"))
    .addColumn("actor_id", "uuid", (c) => c.references("users.id"))
    .addColumn("action", "text", (c) => c.notNull())
    .addColumn("resource_type", "text")
    .addColumn("resource_id", "text")
    .addColumn("detail", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(now))
    .execute();
  await db.schema.createIndex("audit_logs_org").on("audit_logs").columns(["org_id", "id desc"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ["audit_logs", "resource_shares", "team_members", "teams", "org_invites"]) {
    await db.schema.dropTable(table).execute();
  }
}
