/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "../api/tasks-api";

const list = vi.fn();
const listTasks = vi.fn();
const mergeProjectSessions = vi.fn();

vi.mock("../api/sessions-api", () => ({
  sessionsApi: { list: (...a: unknown[]) => list(...a) },
}));
vi.mock("../api/tasks-api", () => ({
  tasksApi: { listTasks: (...a: unknown[]) => listTasks(...a) },
}));
vi.mock("../store/session-store", () => ({
  useSessionStore: (sel: (s: unknown) => unknown) =>
    sel({ mergeProjectSessions }),
}));

import { useProjectListAutoRefresh } from "./use-project-list-auto-refresh";

const task = (over: Partial<Task>): Task => ({
  id: "t1",
  project_id: "A",
  title: "T",
  goal: "g",
  status: "active",
  created_by: "u1",
  lead_agent_slug: "lead",
  current_holder: "lead",
  file_path: "/p",
  created_at: 1,
  updated_at: 1,
  ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

const okSessions = (sessions: unknown[] = []) => ({ sessions });
const okTasks = (tasks: Task[] = []) => ({ tasks });

const render = (pid = "A", onTasks = vi.fn()) =>
  renderHook(
    ({ p }: { p: string }) =>
      useProjectListAutoRefresh(p, { onTasks, intervalMs: 4000 }),
    { initialProps: { p: pid } },
  );

describe("useProjectListAutoRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setHidden(false);
    list.mockResolvedValue(okSessions());
    listTasks.mockResolvedValue(okTasks());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls both endpoints every 4s while visible", async () => {
    render();
    expect(list).not.toHaveBeenCalled(); // no immediate tick on mount
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("A", expect.anything());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("pauses ticks while the tab is hidden", async () => {
    render();
    setHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("catches up immediately on visibilitychange→visible and on online", async () => {
    render();
    setHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(list).not.toHaveBeenCalled();
    await act(async () => {
      setHidden(false); // visibilitychange→visible → immediate fetch
    });
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event("online")); // online → immediate fetch
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("single-flights: an overlapping tick is skipped, not queued", async () => {
    const d = deferred<ReturnType<typeof okSessions>>();
    list.mockReturnValueOnce(d.promise);
    listTasks.mockReturnValueOnce(okTasks());
    render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000); // tick 1 starts, stays in flight
    });
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000); // tick 2 must be skipped
    });
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => {
      d.resolve(okSessions());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000); // now free → tick 3 runs
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung request after intervalMs and does not block the next tick", async () => {
    // First tick hangs until aborted; it must not wedge the single-flight gate.
    list.mockImplementationOnce(
      (_pid: string, init: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () =>
            rej(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    listTasks.mockImplementationOnce(
      (_pid: string, init: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () =>
            rej(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000); // tick 1 starts + arms timeout
    });
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000); // timeout fires → abort → settle
    });
    // Recovery tick can now run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mergeProjectSessions).toHaveBeenCalled();
  });

  it("stays silent on failure and backfills the full table on the next success", async () => {
    list.mockRejectedValueOnce(new Error("net"));
    listTasks.mockRejectedValueOnce(new Error("net"));
    const onTasks = vi.fn();
    render("A", onTasks);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000); // both fail → no writes
    });
    expect(mergeProjectSessions).not.toHaveBeenCalled();
    expect(onTasks).not.toHaveBeenCalled();
    list.mockResolvedValueOnce(okSessions([{ id: "s1", project_id: "A" }]));
    listTasks.mockResolvedValueOnce(okTasks([task({ id: "t1" })]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000); // recovery → full-table backfill
    });
    expect(mergeProjectSessions).toHaveBeenCalledWith("A", [
      { id: "s1", project_id: "A" },
    ]);
    expect(onTasks).toHaveBeenCalledWith([task({ id: "t1" })]);
  });

  it("writes the fulfilled side even when the other side fails (allSettled)", async () => {
    list.mockRejectedValueOnce(new Error("net"));
    listTasks.mockResolvedValueOnce(okTasks([task({ id: "t9" })]));
    const onTasks = vi.fn();
    render("A", onTasks);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mergeProjectSessions).not.toHaveBeenCalled(); // failed side untouched
    expect(onTasks).toHaveBeenCalledWith([task({ id: "t9" })]); // ok side written
  });

  it("discards a late response from the previous project after switching A→B", async () => {
    const dA = deferred<ReturnType<typeof okTasks>>();
    list.mockResolvedValue(okSessions());
    listTasks.mockReturnValueOnce(dA.promise); // A's task fetch, resolves late
    const onTasks = vi.fn();
    const { rerender } = renderHook(
      ({ p }: { p: string }) => useProjectListAutoRefresh(p, { onTasks }),
      { initialProps: { p: "A" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000); // A tick in flight
    });
    // Switch to B before A's response lands.
    listTasks.mockResolvedValue(okTasks());
    rerender({ p: "B" });
    await act(async () => {
      dA.resolve(okTasks([task({ id: "ta", project_id: "A" })]));
      await Promise.resolve();
    });
    // A's late tasks must never reach B's page state.
    expect(onTasks).not.toHaveBeenCalledWith([
      task({ id: "ta", project_id: "A" }),
    ]);
  });

  it("filters cross-project task rows out of onTasks (same-source assertion)", async () => {
    listTasks.mockResolvedValueOnce(
      okTasks([task({ id: "good", project_id: "A" }), task({ id: "bad", project_id: "B" })]),
    );
    const onTasks = vi.fn();
    render("A", onTasks);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(onTasks).toHaveBeenCalledWith([task({ id: "good", project_id: "A" })]);
  });

  it("clears the interval and listeners on unmount (no zombie ticks)", async () => {
    const { unmount } = render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(list).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(list).toHaveBeenCalledTimes(1); // no further ticks after unmount
    // Detached listeners no longer trigger fetches either.
    setHidden(false);
    window.dispatchEvent(new Event("online"));
    expect(list).toHaveBeenCalledTimes(1);
  });
});
