/** The one database entry point: a typed Kysely instance and its migrations. */
import { Kysely, type MigrationResult, Migrator, PostgresDialect } from "kysely";
import pg from "pg";
import { migrations } from "./migrations/index.ts";
import type { Database } from "./schema.ts";

export type {
  ConnectorConfig,
  ConnectorEntry,
  Database,
  OrgRole,
  PrincipalType,
  SharePermission,
  SkillFile,
  StoredModel,
} from "./schema.ts";
export type Db = Kysely<Database>;

// bigint columns (event cursors, token counts, epoch ms) all fit in a JS number.
pg.types.setTypeParser(20, (value) => Number(value));

export function createDb(connectionString: string, options: { max?: number } = {}): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: options.max ?? 20 }) }),
  });
}

const migrator = (db: Db): Migrator => new Migrator({ db, provider: { getMigrations: async () => migrations } });

function applied(label: string, outcome: { error?: unknown; results?: MigrationResult[] }): string[] {
  if (outcome.error) {
    const failed = outcome.results?.find((r) => r.status === "Error")?.migrationName ?? "unknown";
    throw new Error(
      `${label} failed at ${failed}: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
    );
  }
  return (outcome.results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}

/** Apply every pending migration. Safe to call from several replicas at once (Kysely takes a lock). */
export const migrateToLatest = async (db: Db): Promise<string[]> =>
  applied("migrate up", await migrator(db).migrateToLatest());

/** Roll back the most recent migration. */
export const migrateDown = async (db: Db): Promise<string[]> =>
  applied("migrate down", await migrator(db).migrateDown());
