#!/usr/bin/env node
/**
 * agent-base-host — the desktop host process. It links this machine to an
 * agent-base server and runs agent sessions here; the desktop shell supervises
 * it as a sidecar (the role the Python `valuz-server` used to play).
 */
import { hostname } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { type HostConfig, hostHome, loadHostConfig, saveHostConfig } from "./config.ts";
import { Host } from "./executor.ts";

const USAGE = `usage:
  agent-base-host login --server <url> --email <email> [--name <device name>] [--org <org id>]
                        (password from AGENT_BASE_PASSWORD)
  agent-base-host run
  agent-base-host share add <absolute path> | share remove <path> | share exec <on|off>
  agent-base-host status`;

async function api(server: string, route: string, init: { token?: string; org?: string; body?: unknown }): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.replace(/\/+$/, "")}${route}`, {
    method: init.body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.org ? { "x-org-id": init.org } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data["error"] as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`);
  return data;
}

async function requireConfig(): Promise<HostConfig> {
  const config = await loadHostConfig();
  if (!config) throw new Error("this machine is not linked yet — run `agent-base-host login` first");
  return config;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "login": {
      const { values } = parseArgs({ args: rest, options: { server: { type: "string" }, email: { type: "string" }, name: { type: "string" }, org: { type: "string" } } });
      const password = process.env["AGENT_BASE_PASSWORD"];
      if (!values.server || !values.email || !password) throw new Error(USAGE);
      const login = await api(values.server, "/v1/auth/login", { body: { email: values.email, password } });
      const token = login["access_token"] as string;
      const device = await api(values.server, "/v1/devices", { token, org: values.org, body: { name: values.name ?? hostname() } });
      // The user token is discarded; only the device token is kept.
      await api(values.server, "/v1/auth/logout", { body: { refresh_token: login["refresh_token"] } }).catch(() => undefined);
      await saveHostConfig({
        server_url: values.server,
        device_id: device["id"] as string,
        device_token: device["token"] as string,
        owner_user_id: device["owner_id"] as string,
        shared_roots: [],
        allow_exec: false,
      });
      console.log(`linked as device ${String(device["id"])}. Nothing is shared yet — use \`share add <path>\`.`);
      return;
    }
    case "share": {
      const config = await requireConfig();
      const [verb, value] = rest;
      if (verb === "add" && value && path.isAbsolute(value)) {
        config.shared_roots = [...new Set([...config.shared_roots, path.resolve(value)])];
      } else if (verb === "remove" && value) {
        config.shared_roots = config.shared_roots.filter((r) => r !== path.resolve(value));
      } else if (verb === "exec" && (value === "on" || value === "off")) {
        config.allow_exec = value === "on";
      } else {
        throw new Error(USAGE);
      }
      await saveHostConfig(config);
      console.log(`shared folders: ${config.shared_roots.join(", ") || "(none)"}\nremote commands: ${config.allow_exec ? "on" : "off"}`);
      console.log("restart `agent-base-host run` to apply.");
      return;
    }
    case "status": {
      const config = await requireConfig();
      console.log(JSON.stringify({ ...config, device_token: "<hidden>" }, null, 2));
      return;
    }
    case "run": {
      const config = await requireConfig();
      const host = new Host({ config, dataDir: path.join(hostHome(), "data"), log: (line) => console.log(`[host] ${line}`) });
      await host.start();
      console.log(`[host] device ${config.device_id} → ${config.server_url}`);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => void host.stop().finally(() => process.exit(0)));
      }
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = command ? 2 : 0;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
