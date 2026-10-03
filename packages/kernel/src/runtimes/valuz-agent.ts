/**
 * ValuzAgentRuntime — the native Node agent loop that replaces the Python
 * DeepAgents/LangChain runtime. It speaks OpenAI Chat Completions (streaming +
 * tool calls) to any compatible gateway, runs built-in and MCP tools, and
 * checkpoints the thread to a JSON file so history survives restarts.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Session, SubmitAction, UserMessage } from "@agent-base/protocol";
import { buildUserPrompt, modelRejectsImages } from "../prompt-builder.ts";
import { RuntimeConfigError, type RuntimeDeps, type RuntimePort, forkSourceOf } from "../runtime.ts";
import { type EventSink, makeEvent } from "../sinks.ts";
import { skillIndexPrompt } from "../skills.ts";
import { ApprovalBridge, isApproved } from "./approvals.ts";
import { type McpToolset, type ToolContext, type ValuzTool, builtinTools, loadMcpTools } from "./valuz-tools.ts";

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

const BASE_PROMPT = `You are an autonomous agent working inside a project workspace.
Use the available tools to inspect files, run commands, and complete the user's request end to end.
Plan multi-step work with write_todos and keep it current. Prefer reading before editing.
When the work is done, reply with a concise summary of what you did and what you found.`;

const DEFAULT_MAX_INPUT_TOKENS = 120_000;
const KEEP_RECENT_MESSAGES = 12;

/** Parse an OpenAI-compatible SSE body into JSON chunks. */
async function* sseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const part of body) {
    buffer += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      if (payload) yield JSON.parse(payload) as Record<string, unknown>;
    }
  }
}

export class ValuzAgentRuntime implements RuntimePort {
  private sink: EventSink;
  private abort: AbortController | null = null;
  private interrupted = false;
  private mcp: McpToolset | null = null;
  private tools: ValuzTool[] | null = null;
  private history: ChatMessage[] | null = null;
  private readonly approvals = new ApprovalBridge(() => this.sink);
  private readonly sessionApproved = new Set<string>();

  constructor(private readonly deps: RuntimeDeps) {
    this.sink = deps.sink;
  }

  updateSink(sink: EventSink): void {
    this.sink = sink;
  }

  private checkpointPath(sessionId: string): string {
    return path.join(this.deps.dataDir, "checkpoints", `${sessionId}.json`);
  }

  async prepare(session: Session): Promise<void> {
    if (!this.tools) {
      const started = Date.now();
      this.mcp = await loadMcpTools(session.mcp_servers);
      this.tools = [...builtinTools(), ...this.mcp.tools];
      await this.sink.emit(makeEvent("turn_phase", { phase: "runtime_init", duration_ms: Date.now() - started }));
    }
    if (!this.history) {
      // A fork with no thread of its own yet starts from a copy of its source's.
      const fork = forkSourceOf(session);
      const raw =
        (await readFile(this.checkpointPath(session.id), "utf8").catch(() => null)) ??
        (fork ? await readFile(this.checkpointPath(fork.session_id), "utf8").catch(() => null) : null);
      this.history = raw ? (JSON.parse(raw) as ChatMessage[]) : [];
    }
  }

  private async saveCheckpoint(sessionId: string): Promise<void> {
    const file = this.checkpointPath(sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename: a crash mid-write must not corrupt the thread.
    await writeFile(`${file}.tmp`, JSON.stringify(this.history));
    await rename(`${file}.tmp`, file);
  }

  private systemPrompt(session: Session): string {
    return [BASE_PROMPT, session.instructions, skillIndexPrompt(this.deps.skills)].filter(Boolean).join("\n\n");
  }

  async run(session: Session, userMessage: UserMessage): Promise<void> {
    const provider = session.model_provider;
    if (!provider || !session.model.trim()) {
      throw new RuntimeConfigError("valuz_agent requires both `model` and `model_provider`");
    }
    this.interrupted = false;
    this.abort = new AbortController();
    await this.prepare(session);
    const history = this.history as ChatMessage[];
    session.runtime_session_id = session.id;

    history.push({
      role: "user",
      content: buildUserPrompt(userMessage, session.cwd, new Date(), {
        modelRejectsImages: modelRejectsImages(session.model_settings),
      }),
    });

    const total = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    let turns = 0;
    let stop: Session["stop_reason"] = { type: "end_turn" };
    try {
      while (true) {
        if (turns >= session.agent_config.max_turns) {
          stop = { type: "budget_exhausted", reason: "max_turns" };
          break;
        }
        turns += 1;
        const { content, toolCalls, usage } = await this.complete(session, history);
        total.input_tokens += usage.prompt_tokens ?? 0;
        total.output_tokens += usage.completion_tokens ?? 0;
        total.cache_read_tokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
        history.push({ role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
        if (content) await this.sink.emit(makeEvent("assistant_message", { text: content }));
        if (toolCalls.length === 0) break;
        for (const call of toolCalls) {
          history.push({ role: "tool", tool_call_id: call.id, content: await this.callTool(session, call) });
        }
        await this.saveCheckpoint(session.id);
        await this.maybeCompact(session, history, usage.prompt_tokens ?? 0);
      }
    } catch (err) {
      if (!this.interrupted) {
        await this.saveCheckpoint(session.id);
        throw err;
      }
      // An interrupted tool batch leaves tool_calls without results; the API
      // rejects that on the next turn, so close each one out.
      closeDanglingToolCalls(history);
      stop = { type: "user_interrupt" };
    }
    await this.saveCheckpoint(session.id);
    await this.sink.emit(
      makeEvent("usage_update", { ...total, num_turns: turns, model_usage: { [session.model]: { ...total } } }),
    );
    session.status = "idle";
    session.stop_reason = stop;
    await this.sink.emit(makeEvent("session_idle", { stop_reason: stop }));
  }

  /** One streamed chat-completions round-trip. */
  private async complete(
    session: Session,
    history: ChatMessage[],
    options: { tools?: boolean; system?: string; stream?: boolean } = {},
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: Usage }> {
    const provider = session.model_provider as NonNullable<Session["model_provider"]>;
    const base = (provider.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const settings = session.model_settings;
    const withTools = options.tools !== false;
    const emit = options.stream !== false;
    const body: Record<string, unknown> = {
      model: session.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: options.system ?? this.systemPrompt(session) }, ...history],
    };
    if (withTools) {
      body["tools"] = (this.tools ?? []).map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (settings?.temperature != null) body["temperature"] = settings.temperature;
    if (settings?.max_tokens != null) body["max_tokens"] = settings.max_tokens;
    if (settings?.effort) body["reasoning_effort"] = settings.effort === "max" ? "xhigh" : settings.effort;

    const started = Date.now();
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.api_key}` },
      body: JSON.stringify(body),
      signal: this.abort?.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`model request failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 500)}`);
    }
    if (emit) await this.sink.emit(makeEvent("turn_phase", { phase: "dispatch", duration_ms: Date.now() - started }));

    let content = "";
    let usage: Usage = {};
    const calls: ToolCall[] = [];
    for await (const chunk of sseChunks(res.body)) {
      if (chunk["usage"]) usage = chunk["usage"] as Usage;
      const choice = (chunk["choices"] as { delta?: Record<string, unknown> }[] | undefined)?.[0];
      const delta = choice?.delta;
      if (!delta) continue;
      const reasoning = delta["reasoning_content"] ?? delta["reasoning"];
      if (emit && typeof reasoning === "string" && reasoning) {
        await this.sink.emit(makeEvent("thinking_delta", { text: reasoning }));
      }
      if (typeof delta["content"] === "string" && delta["content"]) {
        content += delta["content"];
        if (emit) await this.sink.emit(makeEvent("text_delta", { text: delta["content"] }));
      }
      for (const tc of (delta["tool_calls"] as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined) ?? []) {
        const slot = (calls[tc.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
    return { content, toolCalls: calls.filter(Boolean), usage };
  }

  private async callTool(session: Session, call: ToolCall): Promise<string> {
    const name = call.function.name;
    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    await this.sink.emit(makeEvent("tool_use", { tool_use_id: call.id, name, input: args }));
    const finish = async (content: string, isError: boolean): Promise<string> => {
      await this.sink.emit(makeEvent("tool_result", { tool_use_id: call.id, content, is_error: isError }));
      return content;
    };
    const tool = this.tools?.find((t) => t.name === name);
    if (!tool) return finish(`Unknown tool: ${name}`, true);

    const signal = (this.abort as AbortController).signal;
    const needsApproval =
      tool.approval !== undefined &&
      session.permission_mode !== "full_access" &&
      !(session.permission_mode === "auto_review" && tool.approval === "file_change") &&
      !this.sessionApproved.has(name);
    if (needsApproval) {
      const action = await this.approvals.request(tool.approval as NonNullable<ValuzTool["approval"]>, name, args, signal);
      if (!isApproved(action)) return finish(action.message ?? "The user rejected this action.", true);
      if (action.decision === "approve_for_session") this.sessionApproved.add(name);
      if (action.modified_input) args = action.modified_input;
    }
    const ctx: ToolContext = {
      cwd: session.cwd,
      signal,
      onTodos: (todos) => this.sink.emit(makeEvent("todo_update", { todos })),
    };
    try {
      return await finish(await tool.execute(args, ctx), false);
    } catch (err) {
      if (signal.aborted) throw err;
      return finish(err instanceof Error ? err.message : String(err), true);
    }
  }

  /** Summarize older turns once the prompt nears the model's input window. */
  private async maybeCompact(session: Session, history: ChatMessage[], promptTokens: number): Promise<void> {
    const limit = session.model_settings?.max_input_tokens ?? DEFAULT_MAX_INPUT_TOKENS;
    if (promptTokens < limit * 0.8 || history.length <= KEEP_RECENT_MESSAGES + 2) return;
    // Cut on a user/assistant boundary so no tool result is orphaned from its call.
    let cut = history.length - KEEP_RECENT_MESSAGES;
    while (cut < history.length && history[cut]?.role === "tool") cut += 1;
    const older = history.slice(0, cut);
    const { content } = await this.complete(
      session,
      [
        ...older,
        { role: "user", content: "Summarize the conversation so far: goals, decisions, files touched, open work. Be specific." },
      ],
      { tools: false, stream: false, system: "You compress an agent's working history into a faithful summary." },
    );
    history.splice(0, cut, { role: "user", content: `<conversation-summary>\n${content}\n</conversation-summary>` });
    await this.sink.emit(makeEvent("compaction", { trigger: "auto", pre_tokens: promptTokens }));
    await this.saveCheckpoint(session.id);
  }

  async submitAction(action: SubmitAction): Promise<void> {
    this.approvals.submit(action);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.abort?.abort();
  }

  async close(): Promise<void> {
    this.abort?.abort();
    await this.mcp?.close();
    this.mcp = null;
    this.tools = null;
  }
}

function closeDanglingToolCalls(history: ChatMessage[]): void {
  const answered = new Set(history.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
  for (const m of [...history]) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const call of m.tool_calls) {
      if (!answered.has(call.id)) history.push({ role: "tool", tool_call_id: call.id, content: "[interrupted by user]" });
    }
  }
}
