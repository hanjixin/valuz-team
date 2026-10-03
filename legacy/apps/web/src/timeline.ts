/** Fold a session's event log into what the conversation view renders. */
import type { StreamEvent } from "./api.ts";

export type Item =
  | { kind: "user"; key: string; text: string; messageId: string }
  | { kind: "assistant"; key: string; text: string; streaming: boolean; messageId: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "tool"; key: string; id: string; name: string; input: unknown; result?: unknown; isError?: boolean }
  | { kind: "approval"; key: string; pendingId: string; subject: string; toolName: string; input: unknown; options: string[]; resolved?: string }
  | { kind: "error"; key: string; text: string }
  | { kind: "note"; key: string; text: string };

export interface Timeline {
  items: Item[];
  todos: { content: string; status: string }[] | null;
  lastSeq: number;
  /** Bumped whenever a turn ends, so views can refetch derived state. */
  turnsEnded: number;
}

export const emptyTimeline = (): Timeline => ({ items: [], todos: null, lastSeq: 0, turnsEnded: 0 });

export function applyEvent(prev: Timeline, e: StreamEvent): Timeline {
  if (typeof e.seq === "number" && e.seq <= prev.lastSeq) return prev; // replayed on reconnect
  const t: Timeline = { ...prev, items: [...prev.items], lastSeq: e.seq ?? prev.lastSeq };
  const d = (e["data"] ?? {}) as Record<string, any>;
  const key = String(e.seq ?? `${e.type}-${t.items.length}`);
  const last = t.items[t.items.length - 1];
  switch (e.type) {
    case "user_message":
      t.items.push({ kind: "user", key, text: d["text"] ?? "", messageId: e["message_id"] ?? "" });
      break;
    case "text_delta":
      if (d["parent_tool_use_id"]) break;
      if (last?.kind === "assistant" && last.streaming) t.items[t.items.length - 1] = { ...last, text: last.text + (d["text"] ?? "") };
      else t.items.push({ kind: "assistant", key, text: d["text"] ?? "", streaming: true, messageId: e["message_id"] ?? "" });
      break;
    case "assistant_message":
      // The final text supersedes whatever was streamed for it.
      if (last?.kind === "assistant" && last.streaming) t.items[t.items.length - 1] = { ...last, text: d["text"] ?? last.text, streaming: false };
      else t.items.push({ kind: "assistant", key, text: d["text"] ?? "", streaming: false, messageId: e["message_id"] ?? "" });
      break;
    case "thinking_delta":
      if (last?.kind === "thinking") t.items[t.items.length - 1] = { ...last, text: last.text + (d["text"] ?? "") };
      else t.items.push({ kind: "thinking", key, text: d["text"] ?? "" });
      break;
    case "thinking":
      if (last?.kind === "thinking") t.items[t.items.length - 1] = { ...last, text: d["text"] ?? last.text };
      else t.items.push({ kind: "thinking", key, text: d["text"] ?? "" });
      break;
    case "tool_use":
      t.items.push({ kind: "tool", key, id: d["tool_use_id"], name: d["name"], input: d["input"] });
      break;
    case "tool_result": {
      const i = t.items.findIndex((x) => x.kind === "tool" && x.id === d["tool_use_id"]);
      const tool = t.items[i];
      if (tool?.kind === "tool") t.items[i] = { ...tool, result: d["content"], isError: d["is_error"] === true };
      break;
    }
    case "requires_action":
      t.items.push({ kind: "approval", key, pendingId: d["pending_id"], subject: d["subject"], toolName: d["tool_name"], input: d["input"], options: d["available_decisions"] ?? [] });
      break;
    case "action_resolved": {
      const i = t.items.findIndex((x) => x.kind === "approval" && x.pendingId === d["pending_id"]);
      const a = t.items[i];
      if (a?.kind === "approval") t.items[i] = { ...a, resolved: d["decision"] };
      break;
    }
    case "session_error":
      t.items.push({ kind: "error", key, text: d["message"] ?? "运行出错" });
      break;
    case "compaction":
      t.items.push({ kind: "note", key, text: "上下文已压缩" });
      break;
    case "turn_phase":
      if (d["phase"] === "api_retry") t.items.push({ kind: "note", key, text: `模型接口重试中（第 ${d["attempt"]}/${d["max_retries"]} 次，${d["error"] ?? d["error_status"]}）` });
      break;
    case "todo_update":
      t.todos = d["todos"] ?? null;
      break;
    case "session_idle":
      if (d["stop_reason"]?.type === "user_interrupt") t.items.push({ kind: "note", key, text: "已中断" });
      if (last?.kind === "assistant" && last.streaming) t.items[t.items.length - 1] = { ...last, streaming: false };
      break;
    case "session_update":
      t.turnsEnded += 1;
      break;
  }
  return t;
}
