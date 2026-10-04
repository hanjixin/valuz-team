import { describe, expect, it } from "vitest";
import type { SessionEventDTO } from "../api/sessions-api";
import {
  awaitingBackgroundWakeup,
  deriveBackgroundTasks,
  runningBackgroundTasks,
} from "./bg-tasks";

const evt = (
  seq: number,
  eventType: string,
  payload: Record<string, string>,
  timestamp?: number,
): SessionEventDTO => ({
  seq,
  event: { event_type: eventType, payload },
  timestamp,
});

const started = (seq: number, taskId = "b1u751mdc"): SessionEventDTO =>
  evt(
    seq,
    "session.bg_task.started",
    {
      task_id: taskId,
      tool_use_id: "toolu_1",
      description: "Run pet_names.sh in background",
      task_type: "local_bash",
    },
    1_783_946_600_000,
  );

describe("deriveBackgroundTasks", () => {
  it("marks a started task as running", () => {
    const tasks = deriveBackgroundTasks([started(1)]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: "b1u751mdc",
      toolUseId: "toolu_1",
      description: "Run pet_names.sh in background",
      status: "running",
      startedAtMs: 1_783_946_600_000,
    });
    expect(runningBackgroundTasks(tasks)).toHaveLength(1);
  });

  it("resolves to terminal state on finished (real wire shape)", () => {
    const tasks = deriveBackgroundTasks([
      started(1),
      evt(2, "session.bg_task.finished", {
        task_id: "b1u751mdc",
        status: "completed",
        summary: 'Background command "..." completed (exit code 0)',
        output_file: "/tmp/tasks/b1u751mdc.output",
      }),
    ]);
    expect(tasks[0]).toMatchObject({
      status: "completed",
      summary: expect.stringContaining("exit code 0"),
      outputFile: "/tmp/tasks/b1u751mdc.output",
    });
    expect(runningBackgroundTasks(tasks)).toHaveLength(0);
  });

  it("applies a terminal status carried by an updated patch (JSON string)", () => {
    const tasks = deriveBackgroundTasks([
      started(1),
      evt(2, "session.bg_task.updated", {
        task_id: "b1u751mdc",
        patch: '{"status": "completed", "end_time": 1783946742038}',
      }),
    ]);
    expect(tasks[0]!.status).toBe("completed");
  });

  it("ignores malformed patches and unknown statuses", () => {
    const tasks = deriveBackgroundTasks([
      started(1),
      evt(2, "session.bg_task.updated", { task_id: "b1u751mdc", patch: "{oops" }),
      evt(3, "session.bg_task.updated", {
        task_id: "b1u751mdc",
        patch: '{"status": "weird"}',
      }),
    ]);
    expect(tasks[0]!.status).toBe("running");
  });

  it("synthesizes an entry when finished arrives without its started event", () => {
    const tasks = deriveBackgroundTasks([
      evt(9, "session.bg_task.finished", {
        task_id: "orphan",
        status: "stopped",
        summary: "Runtime closed; background task terminated",
      }),
    ]);
    expect(tasks[0]).toMatchObject({ taskId: "orphan", status: "stopped" });
    expect(runningBackgroundTasks(tasks)).toHaveLength(0);
  });

  it("awaits the wake-up turn after finished, until its session.idle lands", () => {
    const base = [
      evt(1, "message.user", { text: "run it" }),
      started(2),
      evt(3, "session.idle", {}), // launching turn ends
    ];
    expect(awaitingBackgroundWakeup(base)).toBe(false);

    const finished = [
      ...base,
      evt(4, "session.bg_task.finished", { task_id: "b1u751mdc", status: "completed" }),
    ];
    expect(awaitingBackgroundWakeup(finished)).toBe(true); // wake-up reply pending

    const wakeupLanded = [...finished, evt(5, "session.idle", {})];
    expect(awaitingBackgroundWakeup(wakeupLanded)).toBe(false);
  });

  it("tracks multiple tasks independently and skips non-bg events", () => {
    const tasks = deriveBackgroundTasks([
      evt(1, "message.user", { text: "hi" }),
      started(2, "t-a"),
      started(3, "t-b"),
      evt(4, "session.bg_task.finished", { task_id: "t-a", status: "completed" }),
      evt(5, "session.idle", {}),
    ]);
    expect(tasks).toHaveLength(2);
    expect(runningBackgroundTasks(tasks).map((t) => t.taskId)).toEqual(["t-b"]);
  });
});
