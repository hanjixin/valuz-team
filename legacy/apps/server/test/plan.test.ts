import { describe, expect, it } from "vitest";
import { PlanError, TaskPlan, TaskStateError, assertTaskTransition } from "../src/tasks/plan.ts";

const plan = () =>
  TaskPlan.fromJson({
    subtasks: [
      { key: "a", title: "A" },
      { key: "b", title: "B", depends_on: ["a"] },
      { key: "c", title: "C", depends_on: ["a"] },
      { key: "d", title: "D", depends_on: ["b", "c"] },
    ],
  });

describe("TaskPlan", () => {
  it("releases nodes only when every dependency is done", () => {
    const p = plan();
    expect(p.readyKeys()).toEqual(["a"]);
    p.setStatus("a", "in_progress");
    expect(p.readyKeys()).toEqual([]);
    p.setStatus("a", "in_review");
    p.setStatus("a", "done");
    expect(p.readyKeys()).toEqual(["b", "c"]);
    p.setStatus("b", "in_progress");
    p.setStatus("b", "done");
    expect(p.readyKeys()).toEqual(["c"]); // d still waits on c
    expect(p.depsDone("d")).toBe(false);
  });

  it("rejects cycles, dangling and self dependencies, and duplicate keys — and leaves the plan intact", () => {
    const p = plan();
    expect(() => p.patch("a", { depends_on: ["d"] })).toThrow(/cycle/);
    expect(p.get("a")?.depends_on).toEqual([]);
    expect(() => p.patch("a", { depends_on: ["a"] })).toThrow(/itself/);
    expect(() => p.add([{ key: "e", title: "E", depends_on: ["nope"] }])).toThrow(/unknown key/);
    expect(() => p.add([{ key: "a", title: "again" }])).toThrow(/duplicate/);
    expect(p.all.map((n) => n.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("enforces node transitions: done is terminal and nothing can write failed", () => {
    const p = plan();
    expect(() => p.setStatus("a", "done")).toThrow(PlanError); // never ran
    p.setStatus("a", "in_progress");
    expect(() => p.setStatus("a", "failed")).toThrow(/illegal/);
    p.setStatus("a", "done");
    expect(() => p.setStatus("a", "rework")).toThrow(/illegal/);
  });

  it("counts a paused node as unfinished and as dispatchable", () => {
    const p = plan();
    p.setStatus("a", "in_progress");
    p.setStatus("a", "paused");
    expect(p.unresolvedKeys()).toContain("a");
    expect(p.readyKeys()).toEqual(["a"]);
    expect(TaskPlan.fromJson({ subtasks: [] }).unresolvedKeys()).toEqual([]);
  });

  it("lets a lead patch a definition but never status or bookkeeping", () => {
    const p = plan();
    p.patch("b", { goal: "new goal", agent: "writer", depends_on: [] });
    expect(p.get("b")).toMatchObject({ goal: "new goal", agent: "writer", depends_on: [] });
    expect(() => p.patch("b", { status: "done" })).toThrow(/cannot be modified/);
    expect(() => p.patch("b", { attempts: 9 })).toThrow(/cannot be modified/);
    // A model cannot smuggle a status in through plan_task either.
    p.add([{ key: "x", title: "X", status: "done", attempts: 3 }]);
    expect(p.get("x")).toMatchObject({ status: "planned", attempts: 0 });
  });

  it("round-trips through JSON and maps to panel states", () => {
    const p = plan();
    p.setStatus("a", "in_progress");
    const again = TaskPlan.fromJson(JSON.parse(JSON.stringify(p.toJson())));
    expect(again.toPanel().map((n) => [n.key, n.status])).toEqual([["a", "active"], ["b", "pending"], ["c", "pending"], ["d", "pending"]]);
  });
});

describe("task status state machine", () => {
  it("allows resume from soft-terminal states but never out of abandoned", () => {
    for (const from of ["paused", "blocked", "stopped", "completed"] as const) assertTaskTransition(from, "active");
    assertTaskTransition("draft", "abandoned");
    expect(() => assertTaskTransition("abandoned", "active")).toThrow(TaskStateError);
    expect(() => assertTaskTransition("draft", "completed")).toThrow(TaskStateError);
    expect(() => assertTaskTransition("completed", "stopped")).toThrow(TaskStateError);
  });
});
