import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPostgres, startRedis } from "@agent-base/test-utils";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 18790;

/** Start PostgreSQL, Redis and the built server; returns the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const entry = path.join(root, "apps/server/dist/main.js");
  for (const file of [entry, path.join(root, "apps/webui/dist/index.html")]) {
    if (!existsSync(file))
      throw new Error(`${path.relative(root, file)} is missing — run \`pnpm test:e2e\`, which builds first`);
  }
  const [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  const server: ChildProcess = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      REDIS_URL: redis.url,
      APP_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123",
      PORT: String(PORT),
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const stop = async (): Promise<void> => {
    server.kill("SIGTERM");
    await Promise.all([pg.stop(), redis.stop()]);
  };
  for (let attempt = 0; ; attempt++) {
    const healthy = await fetch(`http://127.0.0.1:${PORT}/health`).then(
      (res) => res.ok,
      () => false,
    );
    if (healthy) break;
    if (attempt > 100 || server.exitCode !== null) {
      await stop();
      throw new Error("the server did not become healthy");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return stop;
}
