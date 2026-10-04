import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startModelGateway, startPostgres, startProviderUpstream, startRedis } from "@agent-base/test-utils";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 18790;

/** Start PostgreSQL, Redis and the built server; returns the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const entry = path.join(root, "apps/server/dist/main.js");
  for (const file of [entry, path.join(root, "apps/webui/dist/index.html")]) {
    if (!existsSync(file))
      throw new Error(`${path.relative(root, file)} is missing — run \`pnpm test:e2e\`, which builds first`);
  }
  const [pg, redis, vendor, model] = await Promise.all([
    startPostgres(),
    startRedis(),
    startProviderUpstream(),
    startModelGateway(),
  ]);
  // Conversations in the specs are answered by this stand-in model.
  model.handler = (request) => {
    const system = request.messages[0]?.content ?? "";
    // A task's lead works through the orchestrator's tools, one step per tool result it has seen.
    if (system.includes("You are the LEAD")) {
      const step = request.messages.filter((message) => message.role === "tool").length;
      const tool = (name: string, args: unknown = {}) => ({ tool: { name: `mcp__task__${name}`, args } });
      const script = [
        tool("plan_task", {
          subtasks: [
            { key: "research", title: "Research the market", goal: "Find the numbers.", agent: "Researcher" },
            { key: "write", title: "Write the brief", goal: "Write it up.", agent: "Writer", depends_on: ["research"] },
          ],
        }),
        tool("dispatch", { subtask_key: "research" }),
        tool("await_members", { timeout_s: 30 }),
        tool("review_subtask", { subtask_key: "research", decision: "approve" }),
        tool("dispatch", { subtask_key: "write" }),
        tool("await_members", { timeout_s: 30 }),
        tool("review_subtask", { subtask_key: "write", decision: "approve" }),
        tool("finish_task", { summary: "The brief is written: the market is worth 42.", artifacts: ["brief.md"] }),
      ];
      return script[step] ?? { content: "The task is complete." };
    }
    if (system.includes("You are a MEMBER")) return { content: "Finished my part: the market is worth 42." };
    return { content: "The answer is forty-two." };
  };
  process.env["E2E_MODEL_URL"] = model.url;
  // Specs add model channels that point at this stand-in vendor.
  process.env["E2E_VENDOR_URL"] = vendor.url;
  process.env["E2E_VENDOR_KEY"] = vendor.apiKey;
  const server: ChildProcess = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      REDIS_URL: redis.url,
      APP_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123",
      PORT: String(PORT),
      LOG_LEVEL: "warn",
      // The stand-in vendor is on localhost.
      ALLOW_PRIVATE_UPSTREAMS: "1",
      // Specs never reach the public market index.
      MARKETPLACE_INDEX_URLS: "",
      // What specs upload stays out of the repository.
      STORAGE_DIR: path.join(tmpdir(), `ab-e2e-storage-${process.pid}`),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const stop = async (): Promise<void> => {
    server.kill("SIGTERM");
    await Promise.all([pg.stop(), redis.stop(), vendor.stop(), model.stop()]);
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
