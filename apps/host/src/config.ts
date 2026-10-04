/** Host configuration — one owner-only JSON file under the host's home directory. */
import { homedir } from "node:os";
import path from "node:path";
import Conf from "conf";
import { z } from "zod";

export const HostConfig = z.object({
  server_url: z.string().url(),
  device_id: z.string(),
  device_token: z.string(),
  /** The account that linked this machine; only it bypasses the sharing policy. */
  owner_user_id: z.string(),
  /** Folders other members may work in (sessions, file browsing). Empty = none. */
  shared_roots: z.array(z.string()).default([]),
  /** Whether other members may run shell commands here via remote control. */
  allow_exec: z.boolean().default(false),
});
export type HostConfig = z.infer<typeof HostConfig>;

export const hostHome = (): string => process.env["AGENT_BASE_HOME"] ?? path.join(homedir(), ".agent-base");

// The file holds the device token: keep it readable by its owner only.
const file = (home: string) =>
  new Conf<Record<string, unknown>>({ cwd: home, configName: "host", configFileMode: 0o600 });

export function loadHostConfig(home = hostHome()): HostConfig | null {
  const store = file(home).store;
  return Object.keys(store).length === 0 ? null : HostConfig.parse(store);
}

export function saveHostConfig(config: HostConfig, home = hostHome()): void {
  file(home).store = config;
}
