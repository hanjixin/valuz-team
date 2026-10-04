/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionListItem } from "@valuz/shared";

import { useSessionStore } from "./session-store";

const sess = (over: Partial<SessionListItem>): SessionListItem => ({
  id: "s1",
  project_id: "A",
  name: null,
  status: "idle",
  origin: "user",
  last_user_message_text: null,
  locked_model_id: null,
  locked_provider_id: null,
  runtime_provider: "claude_agent",
  permission_mode: "full_access",
  effort: null,
  task_id: null,
  updated_at: 1,
  ...over,
});

const setSessions = (rows: SessionListItem[]) =>
  useSessionStore.setState({ sessions: rows });
const getSessions = () => useSessionStore.getState().sessions;
const merge = (pid: string, items: SessionListItem[]) =>
  useSessionStore.getState().mergeProjectSessions(pid, items);

describe("mergeProjectSessions", () => {
  beforeEach(() => {
    setSessions([]);
  });

  it("upserts new rows for the project (empty → populated)", () => {
    merge("A", [sess({ id: "s1" }), sess({ id: "s2" })]);
    expect(getSessions().map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("leaves other projects' rows untouched", () => {
    const b1 = sess({ id: "b1", project_id: "B" });
    const b2 = sess({ id: "b2", project_id: "B" });
    setSessions([b1, sess({ id: "a1", project_id: "A" }), b2]);
    merge("A", [sess({ id: "a1", project_id: "A", name: "renamed" })]);
    const rows = getSessions();
    // B rows kept by the SAME reference, in place.
    expect(rows).toContain(b1);
    expect(rows).toContain(b2);
    expect(rows.filter((s) => s.project_id === "B")).toHaveLength(2);
    expect(rows.find((s) => s.id === "a1")?.name).toBe("renamed");
  });

  it("reuses the previous object reference for unchanged rows", () => {
    const a1 = sess({ id: "a1", project_id: "A", updated_at: 5 });
    setSessions([a1]);
    merge("A", [sess({ id: "a1", project_id: "A", updated_at: 5 })]);
    expect(getSessions()[0]).toBe(a1); // same ref → no needless re-render
  });

  it("drops rows that disappeared from the snapshot", () => {
    setSessions([
      sess({ id: "a1", project_id: "A" }),
      sess({ id: "a2", project_id: "A" }),
    ]);
    merge("A", [sess({ id: "a1", project_id: "A" })]);
    expect(getSessions().map((s) => s.id)).toEqual(["a1"]);
  });

  it("rejects cross-project rows (same-source assertion)", () => {
    setSessions([sess({ id: "a1", project_id: "A" })]);
    merge("A", [
      sess({ id: "a1", project_id: "A" }),
      sess({ id: "leak", project_id: "B" }), // must NOT be written
    ]);
    const rows = getSessions();
    expect(rows.find((s) => s.id === "leak")).toBeUndefined();
    expect(rows.map((s) => s.id)).toEqual(["a1"]);
  });

  it("does not duplicate a row across repeated merges (idempotent)", () => {
    merge("A", [sess({ id: "a1", project_id: "A" })]);
    merge("A", [sess({ id: "a1", project_id: "A" })]);
    expect(getSessions().filter((s) => s.id === "a1")).toHaveLength(1);
  });

  it("keeps the same array reference when nothing changed (no-op)", () => {
    const a1 = sess({ id: "a1", project_id: "A", updated_at: 9 });
    setSessions([a1]);
    const before = getSessions();
    merge("A", [sess({ id: "a1", project_id: "A", updated_at: 9 })]);
    expect(getSessions()).toBe(before); // store array untouched
  });
});
