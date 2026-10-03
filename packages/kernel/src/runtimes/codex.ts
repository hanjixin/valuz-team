/**
 * CodexRuntime — drives a session through the Codex SDK (`codex exec` under
 * the hood). The exec transport has no approval channel, so permission modes
 * lower to the sandbox: `full_access` → danger-full-access, anything else →
 * workspace-write with approvals off.
 */
import { Codex, type ThreadEvent, type ThreadItem, type ThreadOptions } from "@openai/codex-sdk";
import type { McpServerConfig, Session, SubmitAction, UserMessage } from "@agent-base/protocol";
import { buildUserPrompt } from "../prompt-builder.ts";
import type { RuntimeDeps, RuntimePort } from "../runtime.ts";
import { type EventSink, makeEvent } from "../sinks.ts";
import { skillIndexPrompt } from "../skills.ts";

type ConfigValue = string | number | boolean | ConfigValue[] | { [key: string]: ConfigValue };

function codexMcpConfig(servers: readonly McpServerConfig[]): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const s of servers) {
    if (s.transport === "stdio") {
      out[s.name] = { command: s.command, args: s.args, env: s.env, env_vars: s.env_vars };
    } else {
      const entry: Record<string, ConfigValue> = { url: s.url, http_headers: s.headers };
      if (s.tool_timeout_sec) entry["tool_timeout_sec"] = s.tool_timeout_sec;
      out[s.name] = entry;
    }
  }
  return out;
}

export class CodexRuntime implements RuntimePort {
  private sink: EventSink;
  private abort: AbortController | null = null;
  private interrupted = false;
  /** Streamed length per agent_message item, to turn snapshots into deltas. */
  private readonly streamed = new Map<string, number>();

  constructor(private readonly deps: RuntimeDeps) {
    this.sink = deps.sink;
  }

  updateSink(sink: EventSink): void {
    this.sink = sink;
  }

  async prepare(): Promise<void> {}

  async run(session: Session, userMessage: UserMessage): Promise<void> {
    this.interrupted = false;
    this.streamed.clear();
    const provider = session.model_provider;
    const codex = new Codex({
      apiKey: provider?.api_key,
      baseUrl: provider?.base_url ?? undefined,
      config: session.mcp_servers.length > 0 ? { mcp_servers: codexMcpConfig(session.mcp_servers) } : undefined,
    });
    const effort = session.model_settings?.effort;
    const options: ThreadOptions = {
      model: session.model || undefined,
      workingDirectory: session.cwd,
      skipGitRepoCheck: true,
      sandboxMode: session.permission_mode === "full_access" ? "danger-full-access" : "workspace-write",
      approvalPolicy: "never",
      ...(effort ? { modelReasoningEffort: effort } : {}),
    };
    const first = !session.runtime_session_id;
    const thread = session.runtime_session_id
      ? codex.resumeThread(session.runtime_session_id, options)
      : codex.startThread(options);

    let prompt = buildUserPrompt(userMessage, session.cwd, new Date());
    // Codex exec takes no system-prompt append: the agent's working method and
    // skill index ride ahead of the thread's first user turn instead.
    const preamble = [session.instructions, skillIndexPrompt(this.deps.skills)].filter(Boolean).join("\n\n");
    if (first && preamble && !userMessage.text.startsWith("/")) {
      prompt = `<agent-instructions>\n${preamble}\n</agent-instructions>\n\n${prompt}`;
    }

    this.abort = new AbortController();
    let failure: string | null = null;
    try {
      const { events } = await thread.runStreamed(prompt, { signal: this.abort.signal });
      await this.sink.emit(makeEvent("turn_phase", { phase: "dispatch" }));
      for await (const event of events) {
        failure = (await this.handle(session, event)) ?? failure;
      }
    } catch (err) {
      if (!this.interrupted) failure = err instanceof Error ? err.message : String(err);
    }
    session.runtime_session_id = thread.id ?? session.runtime_session_id;
    session.status = "idle";
    if (this.interrupted) {
      session.stop_reason = { type: "user_interrupt" };
      await this.sink.emit(makeEvent("session_idle", { stop_reason: session.stop_reason }));
    } else if (failure) {
      session.stop_reason = { type: "error", category: "runtime_error", retry_status: "terminal", message: failure };
      await this.sink.emit(makeEvent("session_error", { category: "runtime_error", message: failure }));
    } else {
      session.stop_reason = { type: "end_turn" };
      await this.sink.emit(makeEvent("session_idle", { stop_reason: session.stop_reason }));
    }
  }

  /** Map one thread event. Returns an error message when the turn failed. */
  private async handle(session: Session, event: ThreadEvent): Promise<string | null> {
    switch (event.type) {
      case "thread.started":
        session.runtime_session_id = event.thread_id;
        return null;
      case "item.started":
      case "item.updated":
      case "item.completed":
        await this.handleItem(event.item, event.type);
        return null;
      case "turn.completed":
        await this.sink.emit(
          makeEvent("usage_update", {
            input_tokens: event.usage.input_tokens,
            output_tokens: event.usage.output_tokens,
            cache_read_tokens: event.usage.cached_input_tokens,
            cache_write_tokens: event.usage.cache_write_input_tokens ?? 0,
            model_usage: { [session.model || "codex"]: event.usage },
          }),
        );
        return null;
      case "turn.failed":
        return event.error.message;
      case "error":
        return event.message;
      default:
        return null;
    }
  }

  private async handleItem(item: ThreadItem, phase: ThreadEvent["type"]): Promise<void> {
    const done = phase === "item.completed";
    const started = phase === "item.started";
    switch (item.type) {
      case "agent_message": {
        const sent = this.streamed.get(item.id) ?? 0;
        if (item.text.length > sent) {
          await this.sink.emit(makeEvent("text_delta", { text: item.text.slice(sent) }));
          this.streamed.set(item.id, item.text.length);
        }
        if (done) await this.sink.emit(makeEvent("assistant_message", { text: item.text }));
        return;
      }
      case "reasoning":
        if (done) await this.sink.emit(makeEvent("thinking", { text: item.text }));
        return;
      case "command_execution":
        if (started) {
          await this.sink.emit(makeEvent("tool_use", { tool_use_id: item.id, name: "shell", input: { command: item.command } }));
        }
        if (done) {
          await this.sink.emit(
            makeEvent("tool_result", {
              tool_use_id: item.id,
              content: item.aggregated_output,
              is_error: item.status === "failed",
              exit_code: item.exit_code ?? null,
            }),
          );
        }
        return;
      case "file_change":
        if (done) {
          await this.sink.emit(makeEvent("tool_use", { tool_use_id: item.id, name: "apply_patch", input: { changes: item.changes } }));
          await this.sink.emit(
            makeEvent("tool_result", {
              tool_use_id: item.id,
              content: item.changes.map((c) => `${c.kind} ${c.path}`).join("\n"),
              is_error: item.status === "failed",
            }),
          );
        }
        return;
      case "mcp_tool_call":
        if (started) {
          await this.sink.emit(
            makeEvent("tool_use", { tool_use_id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments }),
          );
        }
        if (done) {
          await this.sink.emit(
            makeEvent("tool_result", {
              tool_use_id: item.id,
              content: item.error ? item.error.message : (item.result?.content ?? []),
              is_error: item.status === "failed",
            }),
          );
        }
        return;
      case "web_search":
        if (started) {
          await this.sink.emit(makeEvent("tool_use", { tool_use_id: item.id, name: "web_search", input: { query: item.query } }));
        }
        if (done) await this.sink.emit(makeEvent("tool_result", { tool_use_id: item.id, content: "", is_error: false }));
        return;
      case "todo_list":
        await this.sink.emit(
          makeEvent("todo_update", {
            todos: item.items.map((t) => ({ content: t.text, status: t.completed ? "completed" : "pending" })),
          }),
        );
        return;
      case "error":
        // A non-fatal notice from the CLI; the turn goes on. It belongs to no
        // tool call, so it must not surface as an orphan tool_result.
        if (done) await this.sink.emit(makeEvent("turn_phase", { phase: "runtime_notice", message: item.message }));
        return;
    }
  }

  async submitAction(_action: SubmitAction): Promise<void> {
    throw new Error("the codex runtime does not raise approvals");
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.abort?.abort();
  }

  async close(): Promise<void> {
    this.abort?.abort();
  }
}
