import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { migrateDown, migrateUp } from "./migrate.ts";

const [command = "up", arg] = process.argv.slice(2);
const db = new Db(loadConfig().DATABASE_URL);
try {
  if (command === "up") {
    const applied = await migrateUp(db);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "already up to date");
  } else if (command === "down") {
    const reverted = await migrateDown(db, arg ? Number(arg) : 1);
    console.log(reverted.length ? `reverted: ${reverted.join(", ")}` : "nothing to revert");
  } else {
    console.error("usage: migrate [up | down <steps>]");
    process.exitCode = 2;
  }
} finally {
  await db.close();
}
