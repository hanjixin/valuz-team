import { migrateToLatest } from "@agent-base/db";
import { buildServer } from "./app.ts";
import { loadConfig } from "./infra/config.ts";

const config = loadConfig();
const server = await buildServer(config);

// Migrate before serving; Kysely's lock makes this safe with many replicas.
const applied = await migrateToLatest(server.ctx.db);
if (applied.length) server.app.log.info({ applied }, "migrations applied");

await server.app.listen({ host: config.HOST, port: config.PORT });

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(0));
  });
}
