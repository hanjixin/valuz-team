import type { TaskEvent } from "@valuz/core";

export interface DeliverableInfo {
  summary: string;
  artifacts: string[];
  completedAt: number;
}

const readPayload = (ev: TaskEvent): { summary: string; artifacts: string[] } => {
  const p = (ev.payload ?? {}) as { summary?: unknown; artifacts?: unknown };
  const summary = typeof p.summary === "string" ? p.summary.trim() : "";
  const artifacts = Array.isArray(p.artifacts)
    ? p.artifacts.filter((x): x is string => typeof x === "string")
    : [];
  return { summary, artifacts };
};

/**
 * Derive the deliverable card content. ``completedAt`` always comes from the
 * original ``task_completed`` event; summary/artifacts come from the latest
 * non-empty ``deliverable_updated`` (post-completion follow-up edits), falling
 * back to ``task_completed``.
 */
export const deriveDeliverable = (events: TaskEvent[]): DeliverableInfo | null => {
  const completed = events.find((e) => e.type === "task_completed");
  if (!completed) return null;

  let latest = readPayload(completed);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === "deliverable_updated") {
      const upd = readPayload(events[i]);
      if (upd.summary) latest = upd;
      break;
    }
  }
  if (!latest.summary) return null;
  return { summary: latest.summary, artifacts: latest.artifacts, completedAt: completed.created_at };
};
