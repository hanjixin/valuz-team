/** The `memory` tool: one tool, six actions, for an agent to keep and manage what it remembers. */
import type { Ctx } from "../../infra/context.ts";
import { ToolError } from "../../infra/toolkit.ts";
import { askOnDevice } from "../sessions/dispatch.ts";
import * as sessions from "../sessions/service.ts";
import { consolidate } from "./consolidate.ts";
import { TOOL_DESCRIPTION } from "./prompts.ts";
import { tidyIfFull } from "./review.ts";
import * as memory from "./service.ts";

export const MEMORY_TOOLKIT = { name: "memory", path: "/v1/mcp/memory" };
const ACTIONS = ["add", "replace", "remove", "list", "clear", "settings"] as const;

export const MEMORY_TOOLS = [
  {
    name: "memory",
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        target: { type: "string", enum: memory.TARGETS, description: "Required for add/replace/remove/clear." },
        content: { type: "string", description: "The entry text, for add/replace." },
        old_text: { type: "string", description: "A unique substring of an existing entry, for replace/remove." },
        enabled: { type: "boolean", description: "settings: the master switch." },
        auto_extract: { type: "boolean", description: "settings: the background review." },
        custom_instructions: { type: "string", description: "settings: guidance for the background review." },
      },
      required: ["action"],
    },
  },
];

/** Who is calling: the session, and whose memory it reads and writes. */
export type Caller = memory.Owner & { sessionId: string };

/** Who a session is to the memory toolkit: its owner, in its project. */
export async function authorize(ctx: Ctx, sessionId: string): Promise<Caller | null> {
  const session = await sessions.byId(ctx, sessionId);
  return session ? { ...(await memory.ownerOfSession(ctx, session)), sessionId: session.id } : null;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export async function callTool(ctx: Ctx, owner: Caller, tool: string, args: Record<string, unknown>) {
  if (tool !== "memory") throw new ToolError(`unknown tool "${tool}"`);
  const action = args["action"] as (typeof ACTIONS)[number];
  if (!ACTIONS.includes(action)) throw new ToolError("memory: 'action' must be add|replace|remove|list|clear|settings");

  if (action === "settings") {
    const patch = {
      ...(typeof args["enabled"] === "boolean" ? { enabled: args["enabled"] } : {}),
      ...(typeof args["auto_extract"] === "boolean" ? { auto_extract: args["auto_extract"] } : {}),
      ...(typeof args["custom_instructions"] === "string" ? { custom_instructions: args["custom_instructions"] } : {}),
    };
    return Object.keys(patch).length > 0 ? memory.patchSettings(ctx, owner, patch) : memory.getSettings(ctx, owner);
  }
  if (action === "list")
    return { entries: await memory.all(ctx, owner), settings: await memory.getSettings(ctx, owner) };

  const target = args["target"] as memory.Target;
  if (!memory.TARGETS.includes(target)) throw new ToolError("memory: 'target' must be user|global|project");
  const content = text(args["content"]);
  const oldText = text(args["old_text"]);
  if (action === "add" && !content) throw new ToolError("memory: 'content' is required for add");
  if (action === "replace" && (!oldText || !content))
    throw new ToolError("memory: 'old_text' and 'content' are required for replace");
  if (action === "remove" && !oldText) throw new ToolError("memory: 'old_text' is required for remove");
  const write = () => {
    if (action === "add") return memory.add(ctx, owner, target, content, "agent");
    if (action === "replace") return memory.replace(ctx, owner, target, oldText, content, "agent");
    if (action === "remove") return memory.remove(ctx, owner, target, oldText);
    return memory.clear(ctx, owner, target);
  };
  try {
    const result = await write().catch(async (err: unknown) => {
      // No room: tidy the scope — the session's own model does it — and try this once more.
      if (!(err instanceof memory.MemoryError) || !err.message.includes("memory is full")) throw err;
      const tidied = await consolidate(ctx, owner, target, (prompt) => askOnDevice(ctx, owner.sessionId, prompt)).catch(
        () => null,
      );
      if (!tidied?.changed) throw err;
      return write();
    });
    // Nearly full after this write: tidied in the background, before the next one is refused.
    if (action === "add" || action === "replace") await tidyIfFull(ctx, owner, target, owner.sessionId);
    return result;
  } catch (err) {
    if (err instanceof memory.MemoryError) throw new ToolError(`memory: ${err.message}`);
    throw err;
  }
}
