/**
 * ClaudeAgentRuntime — drives a session through the Claude Agent SDK.
 *
 * Each turn is one `query()` resumed from the session's native id, so the
 * runtime holds no long-lived subprocess between turns.
 */
import {
  type CanUseTool,
  type McpServerConfig as SdkMcpServerConfig,
  type Options,
  type Query,
  type SDKMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig, Session, SubmitAction, UserMessage } from "@agent-base/protocol";
import { buildUserPrompt, modelRejectsImages } from "../prompt-builder.ts";
import { type RuntimeDeps, type RuntimePort, forkSourceOf } from "../runtime.ts";
import { type EventSink, makeEvent } from "../sinks.ts";
import { ApprovalBridge, type ApprovalSubject, isApproved } from "./approvals.ts";

export function toSdkMcpServers(servers: readonly McpServerConfig[]): Record<string, SdkMcpServerConfig> {
  const out: Record<string, SdkMcpServerConfig> = {};
  for (const s of servers) {
    if (s.transport === "stdio") {
      const env: Record<string, string> = { ...s.env };
      // `env_vars` name secrets read from the host process env, never persisted.
      for (const key of s.env_vars) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      out[s.name] = { type: "stdio", command: s.command, args: s.args, env };
    } else {
      out[s.name] = { type: s.transport, url: s.url, headers: s.headers };
    }
  }
  return out;
}

const subjectFor = (toolName: string): ApprovalSubject => {
  if (toolName === "AskUserQuestion") return "clarifying_questions";
  if (toolName === "Bash") return "shell_command";
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") return "file_change";
  if (toolName.startsWith("mcp__")) return "mcp_tool_call";
  return "tool_input";
};

type Block = { type: string; [key: string]: unknown };

/**
 * Markers of the Claude Code session that happens to have launched the host
 * (a developer running it from a terminal inside Claude Code). They describe
 * that parent session — its messaging socket, its id — and must never leak
 * into an agent session, least of all one a teammate is driving.
 */
const PARENT_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
];

export class ClaudeAgentRuntime implements RuntimePort {
  private sink: EventSink;
  private active: Query | null = null;
  private abort: AbortController | null = null;
  private interrupted = false;
  /** Set when the model API rejected our credentials — retrying cannot help. */
  private authFailure: string | null = null;
  private readonly approvals = new ApprovalBridge(() => this.sink);

  constructor(private readonly deps: RuntimeDeps) {
    this.sink = deps.sink;
  }

  updateSink(sink: EventSink): void {
    this.sink = sink;
  }

  async prepare(): Promise<void> {}

  private buildOptions(session: Session): Options {
    const provider = session.model_provider;
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of PARENT_SESSION_ENV) delete env[key];
    if (provider) {
      env["ANTHROPIC_API_KEY"] = provider.api_key;
      if (provider.base_url) env["ANTHROPIC_BASE_URL"] = provider.base_url;
    }
    const full = session.permission_mode === "full_access";
    const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
      const action = await this.approvals.request(subjectFor(toolName), toolName, input, signal);
      if (!isApproved(action)) {
        return { behavior: "deny", message: action.message ?? "The user rejected this action." };
      }
      if (action.decision === "answer") {
        return { behavior: "allow", updatedInput: { ...input, answers: action.answers ?? {} } };
      }
      return { behavior: "allow", updatedInput: action.modified_input ?? input };
    };
    this.abort = new AbortController();
    const fork = forkSourceOf(session);
    return {
      abortController: this.abort,
      cwd: session.cwd,
      env,
      model: session.model || undefined,
      systemPrompt: { type: "preset", preset: "claude_code", append: session.instructions },
      mcpServers: toSdkMcpServers(session.mcp_servers),
      includePartialMessages: true,
      // Never inherit the machine owner's personal Claude settings into a shared session.
      settingSources: [],
      plugins: this.deps.skills.length > 0 ? [{ type: "local", path: this.deps.skillsDir }] : [],
      maxTurns: session.agent_config.max_turns,
      maxBudgetUsd: session.agent_config.max_cost_usd,
      // A fork's first turn branches the source thread; after that it resumes its own.
      resume: session.runtime_session_id ?? fork?.native_session_id,
      forkSession: !session.runtime_session_id && fork !== null,
      permissionMode:
        session.mode === "plan"
          ? "plan"
          : full
            ? "bypassPermissions"
            : session.permission_mode === "auto_review"
              ? "acceptEdits"
              : "default",
      allowDangerouslySkipPermissions: full,
      canUseTool: full ? undefined : canUseTool,
      ...(session.model_settings?.effort ? { effort: session.model_settings.effort as Options["effort"] } : {}),
    };
  }

  async run(session: Session, userMessage: UserMessage): Promise<void> {
    this.interrupted = false;
    this.authFailure = null;
    const prompt = buildUserPrompt(userMessage, session.cwd, new Date(), {
      modelRejectsImages: modelRejectsImages(session.model_settings),
    });
    const started = Date.now();
    const q = query({ prompt, options: this.buildOptions(session) });
    this.active = q;
    await this.sink.emit(makeEvent("turn_phase", { phase: "dispatch", duration_ms: Date.now() - started }));
    let terminal = false;
    try {
      for await (const msg of q) {
        terminal = (await this.handle(session, msg)) || terminal;
      }
    } catch (err) {
      if (!this.interrupted && !this.authFailure) throw err;
    } finally {
      this.active = null;
    }
    if (this.authFailure) {
      session.status = "idle";
      session.stop_reason = {
        type: "error",
        category: "authentication_failed",
        retry_status: "terminal",
        message: this.authFailure,
      };
      await this.sink.emit(
        makeEvent("session_error", { category: "authentication_failed", message: this.authFailure }),
      );
    } else if (this.interrupted) {
      session.status = "idle";
      session.stop_reason = { type: "user_interrupt" };
      await this.sink.emit(makeEvent("session_idle", { stop_reason: session.stop_reason }));
    } else if (!terminal) {
      throw new Error("Claude Agent SDK stream ended without a result");
    }
  }

  /** Map one SDK message to kernel events. Returns true on the terminal result. */
  private async handle(session: Session, msg: SDKMessage): Promise<boolean> {
    const parent = "parent_tool_use_id" in msg ? (msg.parent_tool_use_id ?? null) : null;
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") session.runtime_session_id = msg.session_id;
        if (msg.subtype === "compact_boundary") {
          await this.sink.emit(makeEvent("compaction", { ...(msg.compact_metadata as object) }));
        }
        if (msg.subtype === "api_retry") {
          // Make a stalled model call visible instead of a silent spinner.
          await this.sink.emit(
            makeEvent("turn_phase", {
              phase: "api_retry",
              attempt: msg.attempt,
              max_retries: msg.max_retries,
              retry_delay_ms: msg.retry_delay_ms,
              error_status: msg.error_status,
              error: msg.error,
            }),
          );
          // The CLI would back off through all its retries on a rejected
          // credential; that can never succeed, so end the turn now.
          if (msg.error === "authentication_failed" || msg.error_status === 401 || msg.error_status === 403) {
            this.authFailure =
              `The model API rejected the credentials (HTTP ${msg.error_status ?? "?"}). ` +
              (session.model_provider
                ? "Check this session's model channel API key."
                : "This session has no model channel, so the device's own Claude login or ANTHROPIC_API_KEY was used.");
            await this.active?.interrupt().catch(() => this.abort?.abort());
          }
        }
        return false;
      }
      case "stream_event": {
        const ev = msg.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
        if (ev.type !== "content_block_delta" || !ev.delta) return false;
        if (ev.delta.type === "text_delta" && ev.delta.text) {
          await this.sink.emit(makeEvent("text_delta", { text: ev.delta.text, parent_tool_use_id: parent }));
        } else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
          await this.sink.emit(makeEvent("thinking_delta", { text: ev.delta.thinking, parent_tool_use_id: parent }));
        }
        return false;
      }
      case "assistant": {
        for (const block of msg.message.content as unknown as Block[]) {
          if (block.type === "text" && block["text"]) {
            // Sub-agent prose is not the session's answer; only the tool result is.
            if (parent === null) await this.sink.emit(makeEvent("assistant_message", { text: block["text"] }));
          } else if (block.type === "thinking") {
            await this.sink.emit(makeEvent("thinking", { text: block["thinking"], parent_tool_use_id: parent }));
          } else if (block.type === "tool_use") {
            await this.sink.emit(
              makeEvent("tool_use", {
                tool_use_id: block["id"],
                name: block["name"],
                input: block["input"],
                parent_tool_use_id: parent,
              }),
            );
            const input = block["input"] as { todos?: unknown } | undefined;
            if (block["name"] === "TodoWrite" && Array.isArray(input?.todos)) {
              await this.sink.emit(makeEvent("todo_update", { todos: input.todos }));
            }
          }
        }
        return false;
      }
      case "user": {
        const content = msg.message.content;
        if (!Array.isArray(content)) return false;
        for (const block of content as unknown as Block[]) {
          if (block.type !== "tool_result") continue;
          await this.sink.emit(
            makeEvent("tool_result", {
              tool_use_id: block["tool_use_id"],
              content: block["content"],
              is_error: block["is_error"] === true,
              parent_tool_use_id: parent,
            }),
          );
        }
        return false;
      }
      case "result": {
        session.runtime_session_id = msg.session_id;
        await this.sink.emit(
          makeEvent("usage_update", {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
            cache_read_tokens: msg.usage.cache_read_input_tokens,
            cache_write_tokens: msg.usage.cache_creation_input_tokens,
            model_usage: msg.modelUsage,
            num_turns: msg.num_turns,
            total_cost_usd: msg.total_cost_usd,
          }),
        );
        session.status = "idle";
        if (this.interrupted || this.authFailure) return true;
        if (msg.subtype === "success" && !msg.is_error) {
          session.stop_reason = { type: "end_turn" };
          await this.sink.emit(makeEvent("session_idle", { stop_reason: session.stop_reason }));
        } else if (msg.subtype === "error_max_turns" || msg.subtype === "error_max_budget_usd") {
          session.stop_reason = {
            type: "budget_exhausted",
            reason: msg.subtype === "error_max_turns" ? "max_turns" : "max_cost",
          };
          await this.sink.emit(makeEvent("session_idle", { stop_reason: session.stop_reason }));
        } else {
          const detail = msg.subtype === "success" ? msg.result : msg.errors.join("; ") || msg.subtype;
          session.stop_reason = { type: "error", category: "runtime_error", retry_status: "terminal", message: detail };
          await this.sink.emit(makeEvent("session_error", { category: "runtime_error", message: detail }));
        }
        return true;
      }
      default:
        return false;
    }
  }

  async submitAction(action: SubmitAction): Promise<void> {
    this.approvals.submit(action);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    try {
      await this.active?.interrupt();
    } catch {
      this.abort?.abort();
    }
  }

  async close(): Promise<void> {
    this.abort?.abort();
    this.active = null;
  }
}
