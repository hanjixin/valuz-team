import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { PASSWORD, register, signIn } from "./helpers";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/host/dist/cli.js");
const run = promisify(execFile);

/**
 * A multi-agent task, for real: the lead and two members run on a linked host
 * process, the lead driving the server's orchestrator through its tool server,
 * and the app shows the task come to its end.
 */
test("a task is planned, worked by a team on a linked device, and shown finished in the app", async ({
  page,
  request,
  baseURL,
}) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "ab-task-")));
  const env = { ...process.env, AGENT_BASE_HOME: home, AGENT_BASE_PASSWORD: PASSWORD };
  let host: ChildProcess | undefined;
  try {
    const account = await register(request, "taskowner");
    const { headers } = account;
    const post = async (route: string, data: object) => (await request.post(route, { headers, data })).json();
    const channel = await post("/v1/providers", {
      name: "E2E model",
      provider_kind: "compatible",
      api_key: "sk-e2e",
      base_url: process.env["E2E_MODEL_URL"],
      models: ["test-model"],
    });
    for (const [name, description] of [
      ["Analyst", "Plans and reviews"],
      ["Researcher", "Finds the numbers"],
      ["Writer", "Writes it up"],
    ])
      await post("/v1/agents", {
        name,
        description,
        runtime: "deepagents",
        model: "test-model",
        provider_id: channel.id,
      });

    await run(process.execPath, [cli, "login", "--server", baseURL as string, "--email", "taskowner@example.com"], {
      env,
    });
    host = spawn(process.execPath, [cli, "run"], { env, stdio: "ignore" });
    await expect
      .poll(async () => (await (await request.get("/v1/devices", { headers })).json()).devices[0]?.online)
      .toBe(true);

    const project = await post("/v1/projects", { name: "Market brief" });
    for (const slug of ["Analyst", "Researcher", "Writer"])
      await post(`/v1/projects/${project.id}/agents:deploy`, { source_agent_slug: slug });
    const task = await post(`/v1/projects/${project.id}/tasks`, {
      title: "Size the market",
      goal: "Work out how big the market is and write a brief.",
      lead_agent_slug: "Analyst",
    });
    expect(task.status).toBe("active");

    await expect
      .poll(async () => (await (await request.get(`/v1/tasks/${task.id}`, { headers })).json()).task.status, {
        timeout: 30_000,
      })
      .toBe("completed");
    const detail = await (await request.get(`/v1/tasks/${task.id}`, { headers })).json();
    expect(
      detail.runs.map((r: { kind: string; agent_slug: string; status: string }) => [r.kind, r.agent_slug, r.status]),
    ).toEqual([
      ["lead", "Analyst", "completed"],
      ["subtask", "Researcher", "completed"],
      ["subtask", "Writer", "completed"],
    ]);

    await signIn(page, account);
    const failures: string[] = [];
    page.on("response", (res) => {
      if (res.status() >= 400 && /\/v1\/(tasks|runs)/.test(res.url()))
        failures.push(`${res.status()} ${new URL(res.url()).pathname}`);
    });
    await page.goto(`/tasks/${task.id}`);
    await expect(page.getByText("Size the market").first()).toBeVisible();
    await expect(page.getByText("已完成").first()).toBeVisible();
    await expect(page.getByText("The brief is written: the market is worth 42.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /brief\.md/ })).toBeVisible();
    // How it got there: the plan the lead laid down and worked through.
    await page.getByRole("button", { name: /执行过程/ }).click();
    await expect(page.getByText("拆解为 2 个子任务")).toBeVisible();
    await expect(page.getByText(/子任务完成/)).toHaveCount(2); // each dispatch is shown with its outcome
    await expect(page.getByText("审核通过")).toHaveCount(2);
    await page.screenshot({ path: "test-results/task.png", fullPage: true });
    expect(failures).toEqual([]);
  } finally {
    host?.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});
