import { buildServer } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { migrateUp } from "./migrate.ts";

const config = loadConfig();

// Migrate before serving; an advisory lock makes this safe with many replicas.
const bootDb = new Db(config.DATABASE_URL);
const applied = await migrateUp(bootDb);
await bootDb.close();
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);

const server = await buildServer(config);
await server.app.listen({ host: config.HOST, port: config.PORT });

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(0));
  });
}
