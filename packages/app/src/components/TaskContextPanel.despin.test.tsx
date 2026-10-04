/**
 * Regression: a halted task must not show spinning subtasks.
 *
 * The backend parks only ``in_progress`` nodes on pause/stop and deliberately
 * leaves ``in_review`` / ``rework`` intact (so resume doesn't re-run delivered
 * work) — but both project to the spinning ``active`` panel state. When the
 * task itself is not ``active`` no member is live, so the panel must render
 * those as paused (non-spinning), not as a running spinner. See the
 * "点停止后子任务还在转圈" report.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskContextPanel, type PlannedSubtask } from "./TaskContextPanel";

// One subtask sitting in the spinning ``active`` panel state — i.e. an
// ``in_review`` / ``rework`` node the backend left unparked on halt.
const SUBTASKS: PlannedSubtask[] = [
  { key: "A", label: "前端编码实现自动刷新", agent: "frontend", status: "active" },
];

describe("TaskContextPanel subtask spinner gating", () => {
  it("spins the active subtask while the task is active", () => {
    const { container } = render(
      <TaskContextPanel runs={[]} plannedSubtasks={SUBTASKS} taskStatus="active" />,
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("does NOT spin the subtask once the task is stopped", () => {
    const { container } = render(
      <TaskContextPanel runs={[]} plannedSubtasks={SUBTASKS} taskStatus="stopped" />,
    );
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("does NOT spin the subtask once the task is paused", () => {
    const { container } = render(
      <TaskContextPanel runs={[]} plannedSubtasks={SUBTASKS} taskStatus="paused" />,
    );
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});
