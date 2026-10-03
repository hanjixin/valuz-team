import { createDb, migrateDown, migrateToLatest } from "@agent-base/db";

const command = process.argv[2] ?? "up";
const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url, { max: 1 });
try {
  if (command === "up") {
    const applied = await migrateToLatest(db);
    console.info(applied.length ? `applied: ${applied.join(", ")}` : "already up to date");
  } else if (command === "down") {
    const reverted = await migrateDown(db);
    console.info(reverted.length ? `reverted: ${reverted.join(", ")}` : "nothing to revert");
  } else {
    console.error("usage: migrate [up | down]");
    process.exitCode = 2;
  }
} finally {
  await db.destroy();
}
