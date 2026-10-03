/** Reversible SQL migrations: `NNNN_name.up.sql` / `NNNN_name.down.sql`. */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// `src/` in dev, `dist/` once bundled — the migrations folder sits beside both.
export const MIGRATIONS_DIR = path.resolve(here, "..", "migrations");

// One advisory lock so concurrent server replicas never race a migration.
const LOCK_KEY = 4_815_162_342;

async function versions(dir: string): Promise<string[]> {
  return (await readdir(dir))
    .filter((f) => f.endsWith(".up.sql"))
    .map((f) => f.replace(/\.up\.sql$/, ""))
    .sort();
}

export async function migrateUp(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await db.pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version as string));
    for (const version of await versions(dir)) {
      if (done.has(version)) continue;
      const sql = await readFile(path.join(dir, `${version}.up.sql`), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${version} failed: ${(err as Error).message}`);
      }
      applied.push(version);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

/** Roll back the most recent `steps` migrations. */
export async function migrateDown(db: Db, steps = 1, dir = MIGRATIONS_DIR): Promise<string[]> {
  const rows = await db.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT $1", [steps]);
  const reverted: string[] = [];
  for (const { version } of rows) {
    const sql = await readFile(path.join(dir, `${version}.down.sql`), "utf8");
    await db.tx(async (tx) => {
      await tx.query(sql);
      await tx.query("DELETE FROM schema_migrations WHERE version = $1", [version]);
    });
    reverted.push(version);
  }
  return reverted;
}
