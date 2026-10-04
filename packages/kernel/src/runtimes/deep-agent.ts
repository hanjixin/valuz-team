/**
 * DeepAgentRuntime — the native runtime, built on `deepagents` (LangGraph):
 * the same stack the Python build ran, in its JS edition. The library brings
 * the tool loop, planning (`write_todos`), sub-agents (`task`), file and shell
 * tools over the session's folder, and summarization of long threads; MCP
 * servers are attached with `@langchain/mcp-adapters`. What is left here is the
 * seam: turning its stream into kernel events, asking for approval before a
 * tool acts, and keeping each session's thread on disk.
 */
import { type AIMessage, type AIMessageChunk, type BaseMessage, SystemMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { type Connection, MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { McpServerConfig, Session, SubmitAction, UserMessage } from "@agent-base/protocol";
import { LocalShellBackend, createDeepAgent } from "deepagents";
import { ToolMessage, createMiddleware, todoListMiddleware } from "langchain";
import { buildUserPrompt, modelRejectsImages } from "../prompt-builder.ts";
import { RuntimeConfigError, type RuntimeDeps, type RuntimePort, forkSourceOf } from "../runtime.ts";
import { type EventSink, makeEvent } from "../sinks.ts";
import { skillIndexPrompt } from "../skills.ts";
import { ApprovalBridge, type ApprovalSubject, isApproved } from "./approvals.ts";
import { FileCheckpointer, THREAD, threadFile } from "./thread-file.ts";

type Agent = ReturnType<typeof createDeepAgent>;

/** What a tool may change, and so what a member is asked about before it runs. */
function approvalFor(tool: string): ApprovalSubject | null {
  if (tool === "write_file" || tool === "edit_file" || tool === "delete") return "file_change";
  if (tool === "execute") return "shell_command";
  return tool.startsWith("mcp__") ? "mcp_tool_call" : null;
}

/** Raised from inside the graph to end a turn that has used up its model calls. */
class BudgetExhausted extends Error {}

const textOf = (content: unknown, separator = ""): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : ""))
          .filter(Boolean)
          .join(separator)
      : "";

function mcpConnection(server: McpServerConfig): Connection {
  if (server.transport === "stdio")
    return {
      transport: "stdio",
      command: server.command,
      args: [...server.args],
      env: { ...(process.env as Record<string, string>), ...server.env },
    };
  const timeout = server.tool_timeout_sec ? { defaultToolTimeout: server.tool_timeout_sec * 1000 } : {};
  return server.transport === "sse"
    ? { transport: "sse", url: server.url, headers: { ...server.headers }, ...timeout }
    : { transport: "http", url: server.url, headers: { ...server.headers }, ...timeout };
}

/** The session's model, spoken to in the protocol its channel uses: chat completions, or Anthropic messages. */
function chatModel(session: Session): ChatOpenAI | ChatAnthropic {
  const provider = session.model_provider as NonNullable<Session["model_provider"]>;
  const settings = session.model_settings;
  const common = {
    model: session.model,
    apiKey: provider.api_key,
    maxRetries: 0,
    ...(settings?.temperature != null ? { temperature: settings.temperature } : {}),
    ...(settings?.max_tokens != null ? { maxTokens: settings.max_tokens } : {}),
  };
  if (provider.api_protocol === "anthropic")
    return new ChatAnthropic({
      ...common,
      // The SDK appends `/v1/messages` itself.
      ...(provider.base_url ? { anthropicApiUrl: provider.base_url.replace(/\/v1\/?$/, "") } : {}),
    });
  return new ChatOpenAI({
    ...common,
    configuration: { baseURL: provider.base_url ?? "https://api.openai.com/v1" },
    streamUsage: true,
    ...(settings?.effort
      ? { modelKwargs: { reasoning_effort: settings.effort === "max" ? "xhigh" : settings.effort } }
      : {}),
  });
}

export class DeepAgentRuntime implements RuntimePort {
  private sink: EventSink;
  private abort: AbortController | null = null;
  private interrupted = false;
  private mcp: MultiServerMCPClient | null = null;
  private agent: Agent | null = null;
  private thread: FileCheckpointer | null = null;
  /** The session as of the turn in flight: the agent is built once, but each turn brings its own settings. */
  private session: Session | null = null;
  private modelCalls = 0;
  private readonly approvals = new ApprovalBridge(() => this.sink);
  private readonly sessionApproved = new Set<string>();

  constructor(private readonly deps: RuntimeDeps) {
    this.sink = deps.sink;
  }

  updateSink(sink: EventSink): void {
    this.sink = sink;
  }

  forkAnchor(): Record<string, unknown> | null {
    const checkpoint = this.thread?.latest();
    return checkpoint ? { checkpoint_id: checkpoint } : null;
  }

  /** Tool calls pass through here: say what is being done, ask first when the session requires it. */
  private gate() {
    return createMiddleware({
      name: "AgentBaseGate",
      wrapModelCall: async (request, handler) => {
        const session = this.session as Session;
        if (this.modelCalls >= session.agent_config.max_turns) throw new BudgetExhausted();
        this.modelCalls += 1;
        // The library builds the system prompt as content blocks; plenty of OpenAI-compatible
        // gateways only take a string there.
        return handler({ ...request, systemMessage: new SystemMessage(textOf(request.systemMessage.content, "\n\n")) });
      },
      wrapToolCall: async (request, handler) => {
        const session = this.session as Session;
        const { name, id } = request.toolCall;
        let args = request.toolCall.args as Record<string, unknown>;
        const toolUseId = id ?? crypto.randomUUID();
        await this.sink.emit(makeEvent("tool_use", { tool_use_id: toolUseId, name, input: args }));
        const finish = async (content: string, isError: boolean): Promise<ToolMessage> => {
          await this.sink.emit(makeEvent("tool_result", { tool_use_id: toolUseId, content, is_error: isError }));
          return new ToolMessage({ content, tool_call_id: toolUseId, name, status: isError ? "error" : "success" });
        };

        const subject = approvalFor(name);
        const ask =
          subject !== null &&
          session.permission_mode !== "full_access" &&
          !(session.permission_mode === "auto_review" && subject === "file_change") &&
          !this.sessionApproved.has(name);
        if (ask) {
          const action = await this.approvals.request(subject, name, args, this.abort?.signal);
          if (!isApproved(action)) return finish(action.message ?? "The user rejected this action.", true);
          if (action.decision === "approve_for_session") this.sessionApproved.add(name);
          if (action.modified_input) args = action.modified_input;
        }
        try {
          const result = await handler({ ...request, toolCall: { ...request.toolCall, args } });
          // A tool may answer with a state update (write_todos, task) rather than a message.
          if (ToolMessage.isInstance(result)) {
            await this.sink.emit(
              makeEvent("tool_result", {
                tool_use_id: toolUseId,
                content: textOf(result.content),
                is_error: result.status === "error",
              }),
            );
          } else {
            await this.sink.emit(makeEvent("tool_result", { tool_use_id: toolUseId, content: "", is_error: false }));
          }
          return result;
        } catch (err) {
          if (this.abort?.signal.aborted) throw err;
          return finish(err instanceof Error ? err.message : String(err), true);
        }
      },
    });
  }

  async prepare(session: Session): Promise<void> {
    const provider = session.model_provider;
    if (!provider || !session.model.trim())
      throw new RuntimeConfigError("the native runtime requires both `model` and `model_provider`");
    this.session = session;
    if (!this.thread) {
      // A fork with no thread of its own yet starts from a copy of its source's.
      const fork = forkSourceOf(session);
      this.thread = await FileCheckpointer.open(
        threadFile(this.deps.dataDir, session.id),
        fork ? threadFile(this.deps.dataDir, fork.session_id) : null,
      );
    }
    if (this.agent) return;
    const started = Date.now();
    if (session.mcp_servers.length > 0) {
      this.mcp = new MultiServerMCPClient({
        mcpServers: Object.fromEntries(session.mcp_servers.map((server) => [server.name, mcpConnection(server)])),
        // The names a model sees are the ones the other runtimes use: mcp__<server>__<tool>.
        prefixToolNameWithServerName: true,
        additionalToolNamePrefix: "mcp",
      });
    }
    const model = chatModel(session);
    this.agent = createDeepAgent({
      model,
      tools: this.mcp ? await this.mcp.getTools() : [],
      systemPrompt: [session.instructions, skillIndexPrompt(this.deps.skills)].filter(Boolean).join("\n\n"),
      // Files and commands act on the session's own folder, on this machine.
      backend: new LocalShellBackend({ rootDir: session.cwd, virtualMode: false, inheritEnv: true }),
      // Planning (`write_todos`) is langchain's; the gate reports and asks before tools run.
      middleware: [todoListMiddleware(), this.gate()],
      checkpointer: this.thread,
    });
    await this.sink.emit(makeEvent("turn_phase", { phase: "runtime_init", duration_ms: Date.now() - started }));
  }

  async run(session: Session, userMessage: UserMessage): Promise<void> {
    this.interrupted = false;
    this.abort = new AbortController();
    this.modelCalls = 0;
    await this.prepare(session);
    const agent = this.agent as Agent;
    const thread = this.thread as FileCheckpointer;
    session.runtime_session_id = session.id;

    const prompt = buildUserPrompt(userMessage, session.cwd, new Date(), {
      modelRejectsImages: modelRejectsImages(session.model_settings),
    });
    const total = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    let stop: Session["stop_reason"] = { type: "end_turn" };
    const started = Date.now();
    let dispatched = false;
    try {
      const stream = await agent.stream(
        { messages: [{ role: "user", content: prompt }] },
        {
          configurable: { thread_id: THREAD, ...thread.resumeFrom() },
          streamMode: ["messages", "updates"],
          signal: this.abort.signal,
          recursionLimit: 10_000,
        },
      );
      for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
        if (mode === "messages") {
          const [message, meta] = chunk as [AIMessageChunk, { langgraph_checkpoint_ns?: string }];
          // What a sub-agent says while it works is not the session's answer.
          if (meta.langgraph_checkpoint_ns?.includes("tools:") || message.getType() !== "ai") continue;
          if (!dispatched) {
            dispatched = true;
            await this.sink.emit(makeEvent("turn_phase", { phase: "dispatch", duration_ms: Date.now() - started }));
          }
          const reasoning = message.additional_kwargs?.["reasoning_content"];
          if (typeof reasoning === "string" && reasoning)
            await this.sink.emit(makeEvent("thinking_delta", { text: reasoning }));
          const text = textOf(message.content);
          if (text) await this.sink.emit(makeEvent("text_delta", { text }));
          continue;
        }
        for (const update of Object.values(chunk as Record<string, { messages?: BaseMessage[]; todos?: unknown }>)) {
          if (!update) continue;
          if (Array.isArray(update.todos)) await this.sink.emit(makeEvent("todo_update", { todos: update.todos }));
          for (const message of Array.isArray(update.messages) ? update.messages : []) {
            if (message.getType?.() !== "ai") continue;
            const usage = (message as AIMessage).usage_metadata;
            total.input_tokens += usage?.input_tokens ?? 0;
            total.output_tokens += usage?.output_tokens ?? 0;
            total.cache_read_tokens += usage?.input_token_details?.cache_read ?? 0;
            const text = textOf(message.content);
            if (text) await this.sink.emit(makeEvent("assistant_message", { text }));
          }
        }
      }
    } catch (err) {
      if (err instanceof BudgetExhausted) stop = { type: "budget_exhausted", reason: "max_turns" };
      else if (this.interrupted) stop = { type: "user_interrupt" };
      else {
        await thread.save();
        throw err;
      }
    }
    await thread.save();
    await this.sink.emit(
      makeEvent("usage_update", {
        ...total,
        num_turns: this.modelCalls,
        model_usage: { [session.model]: { ...total } },
      }),
    );
    session.status = "idle";
    session.stop_reason = stop;
    await this.sink.emit(makeEvent("session_idle", { stop_reason: stop }));
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
    await this.mcp?.close().catch(() => undefined);
    this.mcp = null;
    this.agent = null;
  }
}
