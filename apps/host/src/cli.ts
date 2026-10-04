#!/usr/bin/env node
/**
 * agent-base-host — the desktop host process. It links this machine to an
 * agent-base server and runs agent sessions here; the desktop shell supervises
 * it as a sidecar (the role the Python `valuz-server` used to play).
 */
import { hostname } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { type HostConfig, hostHome, loadHostConfig, saveHostConfig } from "./config.ts";
import { HOST_VERSION, Host } from "./executor.ts";

async function api(
  server: string,
  route: string,
  init: { token?: string; org?: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.replace(/\/+$/, "")}${route}`, {
    method: init.body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.org ? { "x-org-id": init.org } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data["message"] === "string" ? data["message"] : `HTTP ${res.status}`);
  return data;
}

function requireConfig(): HostConfig {
  const config = loadHostConfig();
  if (!config) throw new Error("this machine is not linked yet — run `agent-base-host login` first");
  return config;
}

const describeSharing = (config: HostConfig): string =>
  `shared folders: ${config.shared_roots.join(", ") || "(none)"}\nremote commands: ${config.allow_exec ? "on" : "off"}`;

function updateSharing(change: (config: HostConfig) => void): void {
  const config = requireConfig();
  change(config);
  saveHostConfig(config);
  console.info(`${describeSharing(config)}\nrestart \`agent-base-host run\` to apply.`);
}

const program = new Command("agent-base-host")
  .description("Links this machine to an agent-base server and runs agent sessions on it.")
  .version(HOST_VERSION);

program
  .command("login")
  .description("link this machine to a server (password is read from AGENT_BASE_PASSWORD)")
  .requiredOption("--server <url>", "the server's address")
  .requiredOption("--email <email>", "your account")
  .option("--name <name>", "what to call this device", hostname())
  .option("--org <id>", "the organization to link it to (default: your first)")
  .action(async (options: { server: string; email: string; name: string; org?: string }) => {
    const password = process.env["AGENT_BASE_PASSWORD"];
    if (!password) throw new Error("set AGENT_BASE_PASSWORD to your account's password");
    const login = await api(options.server, "/v1/auth/login", { body: { email: options.email, password } });
    const device = await api(options.server, "/v1/devices", {
      token: login["access_token"] as string,
      ...(options.org ? { org: options.org } : {}),
      body: { name: options.name },
    });
    // The user's session is discarded; only the device token is kept.
    await api(options.server, "/v1/auth/logout", { body: { refresh_token: login["refresh_token"] } }).catch(
      () => undefined,
    );
    saveHostConfig({
      server_url: options.server,
      device_id: device["id"] as string,
      device_token: device["token"] as string,
      owner_user_id: device["owner_id"] as string,
      shared_roots: [],
      allow_exec: false,
    });
    console.info(`linked as device ${String(device["id"])}. Nothing is shared yet — use \`share add <path>\`.`);
  });

const share = program.command("share").description("choose what other members may reach on this machine");
share
  .command("add <path>")
  .description("let other members work in a folder (absolute path)")
  .action((folder: string) => {
    if (!path.isAbsolute(folder)) throw new Error("the folder must be an absolute path");
    updateSharing((config) => {
      config.shared_roots = [...new Set([...config.shared_roots, path.resolve(folder)])];
    });
  });
share
  .command("remove <path>")
  .description("stop sharing a folder")
  .action((folder: string) =>
    updateSharing((config) => {
      config.shared_roots = config.shared_roots.filter((root) => root !== path.resolve(folder));
    }),
  );
share
  .command("exec <on|off>")
  .description("allow or forbid other members to run commands here")
  .action((value: string) => {
    if (value !== "on" && value !== "off") throw new Error("expected `on` or `off`");
    updateSharing((config) => {
      config.allow_exec = value === "on";
    });
  });

program
  .command("status")
  .description("show how this machine is linked")
  .action(() => console.info(JSON.stringify({ ...requireConfig(), device_token: "<hidden>" }, null, 2)));

program
  .command("run")
  .description("connect to the server and serve sessions until stopped")
  .action(async () => {
    const config = requireConfig();
    const host = new Host({
      config,
      dataDir: path.join(hostHome(), "data"),
      log: (line) => console.info(`[host] ${line}`),
    });
    await host.start();
    console.info(`[host] device ${config.device_id} → ${config.server_url}`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => void host.stop().finally(() => process.exit(0)));
    }
  });

// Said explicitly: the desktop app runs this file with Electron's own Node, where commander
// would otherwise guess the arguments start one place earlier.
program.parseAsync(process.argv, { from: "node" }).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
