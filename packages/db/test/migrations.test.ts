import { type StartedPostgres, startPostgres } from "@agent-base/test-utils";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, createDb, migrateDown, migrateToLatest } from "../src/index.ts";
import { migrations } from "../src/migrations/index.ts";

describe("migrations", () => {
  let pg: StartedPostgres;
  let db: Db;
  const tables = async () =>
    (
      await sql<{
        table_name: string;
      }>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`.execute(db)
    ).rows
      .map((r) => r.table_name)
      .filter((t) => !t.startsWith("kysely_"));

  beforeAll(async () => {
    pg = await startPostgres();
    db = createDb(pg.url);
  });
  afterAll(async () => {
    await db?.destroy();
    await pg?.stop();
  });

  it("applies every migration, and is a no-op the second time", async () => {
    expect(await migrateToLatest(db)).toEqual(Object.keys(migrations));
    expect(await migrateToLatest(db)).toEqual([]);
    expect(await tables()).toContain("app_meta");
  });

  it("rolls every migration back to an empty schema, then forward again", async () => {
    for (const name of Object.keys(migrations).reverse()) expect(await migrateDown(db)).toEqual([name]);
    expect(await tables()).toEqual([]);
    expect(await migrateToLatest(db)).toEqual(Object.keys(migrations));
  });
});
