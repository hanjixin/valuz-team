import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as devices from "../devices/service.ts";
import { RUNTIME_PROTOCOLS } from "../providers/catalog.ts";

const DISPLAY: Record<string, { name: string; binary: string | null }> = {
  claude_agent: { name: "Claude Agent", binary: null },
  codex: { name: "Codex Agent", binary: "codex" },
  deepagents: { name: "Valuz Agent", binary: null },
};
/** Hosts report the native runtime under its kernel name. */
const REPORTED_AS: Record<string, string> = { deepagents: "valuz_agent" };

/**
 * A runtime runs on a device, not on the server: it is available to the caller
 * when a device they may start sessions on is online and reports having it.
 */
export const listRuntimes: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const usable = (await devices.list(ctx, auth)).filter((d) => d.online && d.permission !== "view");
  const reported = new Set(
    usable.flatMap((device) =>
      ((device.info as Schema<"DeviceInfo">).runtimes ?? []).filter((r) => r.available).map((r) => r.runtime),
    ),
  );
  const reason =
    usable.length === 0 ? "没有在线的设备，请先在一台电脑上运行 agent-base-host" : "在线设备上没有这个运行时";
  return {
    runtimes: RUNTIME_PROTOCOLS.map(([id, supported_protocols]) => {
      const available = reported.has(REPORTED_AS[id] ?? id);
      return {
        id,
        display_name: DISPLAY[id]?.name ?? id,
        supported_protocols,
        requires_binary: DISPLAY[id]?.binary ?? null,
        available,
        unavailable_reason: available ? null : reason,
      };
    }),
  };
};
