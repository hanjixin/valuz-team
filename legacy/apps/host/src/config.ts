/** Host configuration — one JSON file under the host's home directory. */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
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
const configPath = (home: string): string => path.join(home, "host.json");

export async function loadHostConfig(home = hostHome()): Promise<HostConfig | null> {
  const raw = await readFile(configPath(home), "utf8").catch(() => null);
  return raw ? HostConfig.parse(JSON.parse(raw)) : null;
}

export async function saveHostConfig(config: HostConfig, home = hostHome()): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(configPath(home), JSON.stringify(config, null, 2), { mode: 0o600 });
  // The file holds the device token — keep it owner-only even if it pre-existed.
  await chmod(configPath(home), 0o600);
}
