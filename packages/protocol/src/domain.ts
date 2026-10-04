/**
 * Kernel domain model — the Node port of valuz-agent `backend/kernel/src/core`
 * (`types.py`, `events.py`, `agent_config.py`). Field names stay snake_case so
 * the wire shape matches the original OpenAPI contract and stored rows.
 */
import { z } from "zod";

export const nowMs = (): number => Date.now();

// -- Structured user input --

export const Attachment = z.object({
  source_path: z.string(),
  parsed_path: z.string().nullable().default(null),
});
export type Attachment = z.infer<typeof Attachment>;

export const UserMessage = z.object({
  text: z.string(),
  attachments: z.array(Attachment).default([]),
  additional_context: z.string().default(""),
});
export type UserMessage = z.infer<typeof UserMessage>;

// -- Model provider + settings --

export const ApiProtocol = z.enum(["anthropic", "openai_completion", "openai_response", "gemini"]);
export type ApiProtocol = z.infer<typeof ApiProtocol>;

export const ModelProvider = z.object({
  api_key: z.string(),
  base_url: z.string().nullable().default(null),
  api_protocol: ApiProtocol.default("anthropic"),
});
export type ModelProvider = z.infer<typeof ModelProvider>;

export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const ModelSettings = z.object({
  temperature: z.number().nullable().default(null),
  max_tokens: z.number().int().nullable().default(null),
  effort: EffortLevel.nullable().default(null),
  max_input_tokens: z.number().int().nullable().default(null),
  input_modalities: z.array(z.string()).nullable().default(null),
});
export type ModelSettings = z.infer<typeof ModelSettings>;

// -- MCP server config (tagged union on `transport`) --

export const McpHttpServerConfig = z.object({
  name: z.string(),
  url: z.string(),
  transport: z.enum(["http", "sse"]).default("http"),
  headers: z.record(z.string()).default({}),
  tool_timeout_sec: z.number().positive().nullable().default(null),
  server_instructions_trusted: z.boolean().default(false),
});
export type McpHttpServerConfig = z.infer<typeof McpHttpServerConfig>;

export const McpStdioServerConfig = z.object({
  name: z.string(),
  transport: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  env_vars: z.array(z.string()).default([]),
});
export type McpStdioServerConfig = z.infer<typeof McpStdioServerConfig>;

export const McpServerConfig = z.union([McpStdioServerConfig, McpHttpServerConfig]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

// -- StopReason --

export const StopReason = z.discriminatedUnion("type", [
  z.object({ type: z.literal("end_turn") }),
  z.object({
    type: z.literal("budget_exhausted"),
    reason: z.enum(["max_turns", "max_cost"]).default("max_turns"),
  }),
  z.object({
    type: z.literal("error"),
    category: z.string().default(""),
    retry_status: z.enum(["retrying", "exhausted", "terminal"]).default("exhausted"),
    message: z.string().default(""),
  }),
  z.object({ type: z.literal("user_interrupt") }),
]);
export type StopReason = z.infer<typeof StopReason>;

// -- Agent config --

/**
 * `valuz_agent` is the native Node runtime that replaces the Python
 * DeepAgents/LangChain one; `deepagents` is accepted as an alias so rows and
 * agent packs exported by the Python build keep working.
 */
export const RuntimeProvider = z.enum(["claude_agent", "codex", "valuz_agent", "deepagents"]);
export type RuntimeProvider = z.infer<typeof RuntimeProvider>;

export const PermissionMode = z.enum(["default", "auto_review", "full_access"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const SessionMode = z.enum(["default", "plan", "goal"]);
export type SessionMode = z.infer<typeof SessionMode>;

export const SubAgentDef = z.object({
  name: z.string(),
  description: z.string().default(""),
  prompt: z.string().default(""),
  tools: z.array(z.string()).default([]),
  model: z.string().nullable().default(null),
  skills: z.array(z.string()).nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});
export type SubAgentDef = z.infer<typeof SubAgentDef>;

export const AgentConfig = z.object({
  id: z.string().default(""),
  name: z.string(),
  model: z.string().default("claude-sonnet-4-6"),
  runtime_provider: RuntimeProvider.default("claude_agent"),
  instructions: z.string().default(""),
  callable_agents: z.array(SubAgentDef).default([]),
  skills: z.array(z.string()).default([]),
  mcp_servers: z.array(McpServerConfig).default([]),
  permission_mode: PermissionMode.default("full_access"),
  // Backstops against a runaway loop, not a spend control (see agent_config.py).
  max_turns: z.number().int().default(1000),
  max_cost_usd: z.number().default(500),
  effort: EffortLevel.nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

// -- Session / Message --

export const SessionStatus = z.enum(["created", "idle", "running", "terminated"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const TodoItem = z
  .object({ content: z.string(), status: z.string(), activeForm: z.string().optional() })
  .passthrough();
export type TodoItem = z.infer<typeof TodoItem>;

/**
 * A skill materialized into the session's runtime: the kernel writes `files`
 * under the skills directory the runtime discovers. Resolved by the server
 * from the shared skill library at dispatch time.
 */
export const SkillBundle = z.object({
  slug: z.string(),
  version: z.number().int().default(1),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});
export type SkillBundle = z.infer<typeof SkillBundle>;

export const Session = z.object({
  id: z.string(),
  agent_config: AgentConfig,
  cwd: z.string().min(1),
  runtime_provider: RuntimeProvider.default("claude_agent"),
  user_id: z.string().default(""),
  model: z.string().default(""),
  model_provider: ModelProvider.nullable().default(null),
  model_settings: ModelSettings.nullable().default(null),
  instructions: z.string().default(""),
  skills: z.array(z.string()).default([]),
  mcp_servers: z.array(McpServerConfig).default([]),
  permission_mode: PermissionMode.default("full_access"),
  mode: SessionMode.default("default"),
  status: SessionStatus.default("created"),
  stop_reason: StopReason.nullable().default(null),
  created_at: z
    .number()
    .int()
    .default(() => nowMs()),
  metadata: z.record(z.unknown()).default({}),
  runtime_session_id: z.string().nullable().default(null),
  todos: z.array(TodoItem).nullable().default(null),
});
export type Session = z.infer<typeof Session>;

export const MessageStatus = z.enum(["running", "completed", "errored", "cancelled"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const Message = z.object({
  id: z.string(),
  session_id: z.string(),
  user_message: UserMessage,
  started_at: z.number().int(),
  status: MessageStatus.default("running"),
  assistant_message: z.string().nullable().default(null),
  error_message: z.record(z.unknown()).nullable().default(null),
  stop_reason: StopReason.nullable().default(null),
  total_turns: z.number().int().default(0),
  input_tokens: z.number().int().nullable().default(null),
  output_tokens: z.number().int().nullable().default(null),
  cache_read_tokens: z.number().int().nullable().default(null),
  cache_write_tokens: z.number().int().nullable().default(null),
  model_usage: z.record(z.unknown()).nullable().default(null),
  ended_at: z.number().int().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
  todos: z.array(TodoItem).nullable().default(null),
});
export type Message = z.infer<typeof Message>;

// -- Events --

export const OUTBOUND_EVENT_TYPES = [
  "text_delta",
  "assistant_message",
  "tool_use",
  "tool_result",
  "tool_input_delta",
  "tool_output_delta",
  "thinking",
  "thinking_delta",
  "session_idle",
  "session_error",
  "session_update",
  "compaction",
  "usage_update",
  "todo_update",
  "requires_action",
  "action_resolved",
  "mode_changed",
  "plan_update",
  "plan_proposed",
  "turn_phase",
] as const;
export const INBOUND_EVENT_TYPES = ["user_message", "interrupt"] as const;

export const EventType = z.enum([...OUTBOUND_EVENT_TYPES, ...INBOUND_EVENT_TYPES]);
export type EventType = z.infer<typeof EventType>;

export const KernelEvent = z.object({
  type: EventType,
  data: z.record(z.unknown()).default({}),
  timestamp: z
    .number()
    .int()
    .default(() => nowMs()),
});
export type KernelEvent = z.infer<typeof KernelEvent>;

/** One persisted event row; `seq` is the global paging cursor clients use. */
export const StoredEvent = z.object({
  seq: z.number().int(),
  session_id: z.string(),
  message_id: z.string(),
  type: z.string(),
  data: z.record(z.unknown()).default({}),
  timestamp: z.number().int(),
  event_uid: z.string().nullable().default(null),
});
export type StoredEvent = z.infer<typeof StoredEvent>;

export const ActionDecision = z.enum(["approve", "approve_with_changes", "approve_for_session", "reject", "answer"]);
export type ActionDecision = z.infer<typeof ActionDecision>;

export const AVAILABLE_DECISIONS_V1 = ["approve", "reject"] as const;
export const AVAILABLE_DECISIONS_EDITABLE = ["approve", "approve_with_changes", "reject"] as const;
export const AVAILABLE_DECISIONS_CLARIFYING = ["answer", "reject"] as const;

export const SubmitAction = z.object({
  pending_id: z.string(),
  decision: ActionDecision,
  message: z.string().nullable().default(null),
  answers: z
    .record(z.union([z.string(), z.array(z.string())]))
    .nullable()
    .default(null),
  modified_input: z.record(z.unknown()).nullable().default(null),
});
export type SubmitAction = z.infer<typeof SubmitAction>;
