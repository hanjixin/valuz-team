import { describe, expect, it } from "vitest";
import { deriveDeliverable } from "./deliverable";
import type { TaskEvent } from "@valuz/core";

const ev = (over: Partial<TaskEvent>): TaskEvent => ({
  id: "e", sequence: 0, type: "kickoff", actor: "user",
  session_id: null, payload: {}, created_at: 0, ...over,
});

describe("deriveDeliverable", () => {
  it("returns null when no task_completed event", () => {
    expect(deriveDeliverable([ev({ type: "kickoff" })])).toBeNull();
  });

  it("reads summary/artifacts from task_completed", () => {
    const r = deriveDeliverable([
      ev({ type: "task_completed", created_at: 100,
           payload: { summary: "v1", artifacts: ["a.md"] } }),
    ]);
    expect(r).toEqual({ summary: "v1", artifacts: ["a.md"], completedAt: 100 });
  });

  it("prefers the latest deliverable_updated but keeps completedAt from task_completed", () => {
    const r = deriveDeliverable([
      ev({ type: "task_completed", created_at: 100,
           payload: { summary: "v1", artifacts: ["a.md"] } }),
      ev({ type: "deliverable_updated", created_at: 200,
           payload: { summary: "v2", artifacts: ["a.md", "b.md"] } }),
    ]);
    expect(r).toEqual({ summary: "v2", artifacts: ["a.md", "b.md"], completedAt: 100 });
  });

  it("ignores deliverable_updated with empty summary", () => {
    const r = deriveDeliverable([
      ev({ type: "task_completed", created_at: 100, payload: { summary: "v1", artifacts: [] } }),
      ev({ type: "deliverable_updated", created_at: 200, payload: { summary: "  ", artifacts: [] } }),
    ]);
    expect(r?.summary).toBe("v1");
  });

  it("treats a missing payload defensively (no summary → null)", () => {
    const r = deriveDeliverable([
      ev({ type: "task_completed", created_at: 100, payload: undefined as never }),
    ]);
    expect(r).toBeNull();
  });

  it("filters out non-string artifacts", () => {
    const r = deriveDeliverable([
      ev({
        type: "task_completed",
        created_at: 100,
        payload: { summary: "v1", artifacts: ["a.md", 42, null, "b.md"] },
      }),
    ]);
    expect(r?.artifacts).toEqual(["a.md", "b.md"]);
  });
});
