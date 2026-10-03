/** Built-in tools for the native Valuz runtime, plus MCP tool loading. */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, TodoItem } from "@agent-base/protocol";
import type { ApprovalSubject } from "./approvals.ts";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  onTodos: (todos: TodoItem[]) => Promise<void>;
}

export interface ValuzTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Set when the call changes the world and must be approvable. */
  approval?: ApprovalSubject;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const MAX_OUTPUT = 30_000;
const clip = (text: string): string =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… [truncated ${text.length - MAX_OUTPUT} chars]` : text;

const str = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`argument "${key}" must be a string`);
  return v;
};

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, signal, timeout: timeoutMs });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (err) => resolve(clip(`${out}\n[error] ${err.message}`.trim())));
    child.on("close", (code, sig) =>
      resolve(clip(`${out}${code === 0 ? "" : `\n[exit ${sig ?? code}]`}`.trim() || "(no output)")),
    );
  });
}

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "dist", "__pycache__"]);

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 12) return;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full, depth + 1);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export function builtinTools(): ValuzTool[] {
  return [
    {
      name: "read_file",
      description: "Read a text file. Paths are relative to the workspace unless absolute.",
      parameters: obj(
        { path: { type: "string" }, offset: { type: "integer", description: "1-based first line" }, limit: { type: "integer" } },
        ["path"],
      ),
      async execute(args, ctx) {
        const text = await readFile(path.resolve(ctx.cwd, str(args, "path")), "utf8");
        const lines = text.split("\n");
        const offset = Math.max(1, Number(args["offset"] ?? 1));
        const limit = Number(args["limit"] ?? 2000);
        return clip(
          lines
            .slice(offset - 1, offset - 1 + limit)
            .map((l, i) => `${offset + i}\t${l}`)
            .join("\n"),
        );
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file with the given content.",
      parameters: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      approval: "file_change",
      async execute(args, ctx) {
        const target = path.resolve(ctx.cwd, str(args, "path"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, str(args, "content"));
        return `wrote ${target}`;
      },
    },
    {
      name: "edit_file",
      description: "Replace one exact occurrence of old_string with new_string in a file.",
      parameters: obj(
        { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
        ["path", "old_string", "new_string"],
      ),
      approval: "file_change",
      async execute(args, ctx) {
        const target = path.resolve(ctx.cwd, str(args, "path"));
        const text = await readFile(target, "utf8");
        const oldString = str(args, "old_string");
        const count = text.split(oldString).length - 1;
        if (count !== 1) throw new Error(`old_string must match exactly once (found ${count})`);
        await writeFile(target, text.replace(oldString, () => str(args, "new_string")));
        return `edited ${target}`;
      },
    },
    {
      name: "list_dir",
      description: "List the entries of a directory.",
      parameters: obj({ path: { type: "string" } }, []),
      async execute(args, ctx) {
        const dir = path.resolve(ctx.cwd, typeof args["path"] === "string" ? args["path"] : ".");
        const entries = await readdir(dir, { withFileTypes: true });
        return clip(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join("\n") || "(empty)");
      },
    },
    {
      name: "grep",
      description: "Search file contents under a directory with a JavaScript regular expression.",
      parameters: obj({ pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]),
      async execute(args, ctx) {
        const re = new RegExp(str(args, "pattern"));
        const root = path.resolve(ctx.cwd, typeof args["path"] === "string" ? args["path"] : ".");
        const hits: string[] = [];
        for await (const file of walk(root)) {
          if (ctx.signal.aborted || hits.length >= 200) break;
          if ((await stat(file)).size > 2_000_000) continue;
          const text = await readFile(file, "utf8").catch(() => "");
          if (text.includes("\u0000")) continue;
          text.split("\n").forEach((line, i) => {
            if (hits.length < 200 && re.test(line)) hits.push(`${path.relative(ctx.cwd, file)}:${i + 1}: ${line.trim()}`);
          });
        }
        return clip(hits.join("\n") || "no matches");
      },
    },
    {
      name: "bash",
      description: "Run a shell command in the workspace and return its combined output.",
      parameters: obj({ command: { type: "string" }, timeout_ms: { type: "integer" } }, ["command"]),
      approval: "shell_command",
      execute: (args, ctx) =>
        runShell(str(args, "command"), ctx.cwd, ctx.signal, Math.min(Number(args["timeout_ms"] ?? 120_000), 600_000)),
    },
    {
      name: "write_todos",
      description: "Replace the task list. Use it to plan multi-step work and to mark progress.",
      parameters: obj(
        {
          todos: {
            type: "array",
            items: obj(
              { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } },
              ["content", "status"],
            ),
          },
        },
        ["todos"],
      ),
      async execute(args, ctx) {
        if (!Array.isArray(args["todos"])) throw new Error('argument "todos" must be an array');
        await ctx.onTodos(args["todos"] as TodoItem[]);
        return "todo list updated";
      },
    },
  ];
}

export interface McpToolset {
  tools: ValuzTool[];
  close(): Promise<void>;
}

/** Connect every configured MCP server and expose its tools as `mcp__<server>__<tool>`. */
export async function loadMcpTools(servers: readonly McpServerConfig[]): Promise<McpToolset> {
  const clients: Client[] = [];
  const tools: ValuzTool[] = [];
  for (const server of servers) {
    const client = new Client({ name: "agent-base", version: "0.1.0" });
    if (server.transport === "stdio") {
      const env: Record<string, string> = { ...(process.env as Record<string, string>), ...server.env };
      await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env }));
    } else {
      const init = { requestInit: { headers: server.headers } };
      const url = new URL(server.url);
      await client.connect(
        server.transport === "sse" ? new SSEClientTransport(url, init) : new StreamableHTTPClientTransport(url, init),
      );
    }
    clients.push(client);
    const timeout = server.transport !== "stdio" && server.tool_timeout_sec ? server.tool_timeout_sec * 1000 : undefined;
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      tools.push({
        name: `mcp__${server.name}__${tool.name}`,
        description: tool.description ?? "",
        parameters: tool.inputSchema as Record<string, unknown>,
        approval: tool.annotations?.readOnlyHint ? undefined : "mcp_tool_call",
        async execute(args, ctx) {
          const result = await client.callTool({ name: tool.name, arguments: args }, undefined, {
            signal: ctx.signal,
            ...(timeout ? { timeout } : {}),
          });
          const blocks = Array.isArray(result.content) ? (result.content as { type: string; text?: string }[]) : [];
          const text = blocks.map((b) => (b.type === "text" ? (b.text ?? "") : `[${b.type}]`)).join("\n");
          if (result.isError) throw new Error(text || "MCP tool failed");
          return clip(text || JSON.stringify(result.structuredContent ?? {}));
        },
      });
    }
  }
  return { tools, close: async () => void (await Promise.all(clients.map((c) => c.close().catch(() => undefined)))) };
}
