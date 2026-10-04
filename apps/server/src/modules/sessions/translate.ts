/**
 * Kernel events → the frames the web app renders.
 *
 * The conversation UI was written against an older event vocabulary
 * (`message.user`, `message.assistant.delta`, `tool.call.started`, …) and
 * reads every payload value as a string, JSON-parsing the structured ones.
 * Kernel events are mapped to that shape here, at the edge; an event with no
 * counterpart is not shown.
 */
import type { Schema } from "@agent-base/contract";

type Data = Record<string, unknown>;
type Payload = Record<string, string>;

export function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

const text = (data: Data, ...keys: string[]): string => stringify(keys.map((key) => data[key]).find(Boolean) ?? "");

/**
 * What an approval card shows. The kernel reports the tool and its arguments;
 * the card reads the arguments it knows by name (`command`, `path`) directly.
 */
const approvalPayload = (d: Data): Data => ({
  ...(typeof d["input"] === "object" && d["input"] !== null ? (d["input"] as Data) : {}),
  tool_name: d["tool_name"] ?? "",
  input: d["input"] ?? {},
});

/** How each kernel event becomes a frame: its name on the wire, and its payload. */
const RULES: Record<string, [string, (data: Data) => Payload]> = {
  user_message: [
    "message.user",
    (d) => ({ text: text(d, "message", "text"), attachments: stringify(d["attachments"] ?? []) }),
  ],
  assistant_message: ["message.assistant.delta", (d) => ({ text: text(d, "text", "content") })],
  thinking: ["message.assistant.thinking", (d) => ({ text: text(d, "text", "content") })],
  text_delta: ["message.assistant.text_delta", (d) => ({ text: text(d, "text", "delta") })],
  thinking_delta: ["message.assistant.thinking_delta", (d) => ({ text: text(d, "text", "delta") })],
  tool_use: [
    "tool.call.started",
    (d) => ({
      id: text(d, "id"),
      tool_use_id: text(d, "id"),
      name: text(d, "name"),
      input: stringify(d["input"] ?? {}),
    }),
  ],
  tool_result: [
    "tool.call.completed",
    (d) => ({
      id: text(d, "id"),
      tool_use_id: text(d, "id"),
      content: text(d, "content"),
      is_error: stringify(d["is_error"] ?? false),
    }),
  ],
  tool_input_delta: [
    "tool.call.input_delta",
    (d) => ({ tool_use_id: text(d, "id"), name: text(d, "name"), text: text(d, "text", "delta") }),
  ],
  tool_output_delta: [
    "tool.call.output_delta",
    (d) => ({
      tool_use_id: text(d, "id", "tool_use_id"),
      stream: text(d, "stream"),
      text: text(d, "text", "delta", "output"),
    }),
  ],
  session_error: [
    "run.failed",
    (d) => ({ message: text(d, "message", "category") || "agent run failed", category: text(d, "category") }),
  ],
  usage_update: [
    "runtime.engine.usage",
    (d) => ({
      input_tokens: stringify(d["input_tokens"] ?? 0),
      output_tokens: stringify(d["output_tokens"] ?? 0),
      cache_read_tokens: stringify(d["cache_read_tokens"] ?? 0),
      cache_write_tokens: stringify(d["cache_write_tokens"] ?? 0),
      model_usage: stringify(d["model_usage"] ?? {}),
    }),
  ],
  todo_update: ["session.todos.update", (d) => ({ todos: stringify(d["todos"] ?? []) })],
  session_idle: ["session.idle", (d) => ({ stop_reason: stringify(d["stop_reason"] ?? "") })],
  session_update: ["session.update", (d) => ({ status: text(d, "status") })],
  compaction: ["session.compaction", (d) => ({ summary: text(d, "summary") })],
  requires_action: [
    "session.requires_action",
    (d) => ({
      pending_id: text(d, "pending_id"),
      subject: text(d, "subject"),
      runtime_provider: text(d, "runtime_provider"),
      available_decisions: stringify(d["available_decisions"] ?? []),
      payload: stringify(d["payload"] ?? approvalPayload(d)),
      expires_at: text(d, "expires_at"),
      session_rule_preview: stringify(d["session_rule_preview"] ?? {}),
      original_input: stringify(d["original_input"] ?? d["input"] ?? {}),
    }),
  ],
  action_resolved: [
    "session.action_resolved",
    (d) => ({
      pending_id: text(d, "pending_id"),
      decision: text(d, "decision"),
      resolved_by: text(d, "resolved_by"),
      message: text(d, "message"),
      answers: stringify(d["answers"] ?? {}),
      rule_id: text(d, "rule_id"),
      auto_resolved_by_rule_id: text(d, "auto_resolved_by_rule_id"),
    }),
  ],
  mode_changed: ["session.mode_changed", (d) => ({ mode: text(d, "mode") || "default", by: text(d, "by") })],
  plan_update: ["session.plan_update", (d) => ({ steps: stringify(d["steps"] ?? d["plan"] ?? []) })],
  plan_proposed: ["session.plan_proposed", (d) => ({ plan: text(d, "plan") })],
  turn_phase: ["session.turn_phase", (d) => ({ phase: text(d, "phase") })],
};

export interface StoredEventRow {
  seq: number;
  message_id: string;
  type: string;
  data: Data;
  ts: number;
  event_uid: string;
}

/** The frame for one stored event, or null when the web app has no use for it. */
export function toFrame(row: StoredEventRow): Schema<"SessionEventFrame"> | null {
  const rule = RULES[row.type];
  if (!rule) return null;
  const [event_type, build] = rule;
  const payload = build(row.data);
  // Every frame says which turn it belongs to, and whether it came from inside a sub-agent.
  payload["message_id"] ??= stringify(row.data["message_id"] ?? row.message_id);
  if (row.data["parent_tool_use_id"] != null) payload["parent_tool_use_id"] = stringify(row.data["parent_tool_use_id"]);
  return { seq: row.seq, event_type, payload, timestamp: row.ts, event_uid: row.event_uid };
}

/** The nested shape the history endpoints return. */
export const toEnvelope = (frame: Schema<"SessionEventFrame">): Schema<"SessionEventEnvelope"> => ({
  seq: frame.seq,
  event: { event_type: frame.event_type as string, payload: frame.payload ?? {} },
  timestamp: frame.timestamp ?? null,
  event_uid: frame.event_uid ?? null,
});

/**
 * The lean projection for the caller's own stream: that a run started, changed
 * status or ended — never what was said.
 */
export function toControlFrame(row: StoredEventRow & { session_id: string }) {
  const data = row.data;
  const projected: [string, Payload] | null =
    row.type === "user_message"
      ? ["run.started", {}]
      : row.type === "session_idle"
        ? ["run.finished", { status: "idle", stop_reason: stringify(data["stop_reason"] ?? "") }]
        : row.type === "session_error"
          ? ["run.finished", { status: "failed", message: text(data, "message", "category") || "agent run failed" }]
          : row.type === "session_update"
            ? ["run.status", { status: text(data, "status") }]
            : null;
  if (!projected) return null;
  const [event_type, payload] = projected;
  return {
    seq: row.seq,
    event_type,
    session_id: row.session_id,
    payload,
    timestamp: row.ts,
    event_uid: row.event_uid,
  };
}
