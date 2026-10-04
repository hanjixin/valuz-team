import { describe, expect, it } from "vitest";
import {
  parseWorkflowProgress,
  SESSION_WORKFLOW_PROGRESS_EVENT,
  type SessionEventDTO,
} from "./sessions-api";

function makeFrame(
  eventType: string,
  payload: Record<string, string>,
): SessionEventDTO {
  return { seq: 1, event: { event_type: eventType, payload } };
}

describe("parseWorkflowProgress", () => {
  it("should decode the host's JSON-stringified state snapshot", () => {
    const state = {
      runId: "wf_abc",
      workflowName: "deep-research",
      status: "running",
      agentCount: 3,
      agentsDone: 1,
      workflowProgress: [
        { type: "workflow_agent", agentId: "a1", state: "done" },
        { type: "workflow_agent", agentId: "a2", state: "progress" },
      ],
    };
    const frame = makeFrame(SESSION_WORKFLOW_PROGRESS_EVENT, {
      id: "tool-wf",
      run_id: "wf_abc",
      state: JSON.stringify(state),
      message_id: "msg-1",
    });

    const parsed = parseWorkflowProgress(frame);

    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe("tool-wf");
    expect(parsed!.run_id).toBe("wf_abc");
    expect(parsed!.message_id).toBe("msg-1");
    expect(parsed!.state.workflowName).toBe("deep-research");
    expect(parsed!.state.status).toBe("running");
    expect(parsed!.state.agentCount).toBe(3);
    expect(parsed!.state.agentsDone).toBe(1);
    expect(parsed!.state.workflowProgress).toEqual([
      { type: "workflow_agent", agentId: "a1", state: "done", label: undefined, phase: undefined },
      { type: "workflow_agent", agentId: "a2", state: "progress", label: undefined, phase: undefined },
    ]);
  });

  it("should return null when the frame is not a workflow_progress event", () => {
    const frame = makeFrame("message.assistant.delta", { text: "hi" });
    expect(parseWorkflowProgress(frame)).toBeNull();
  });

  it("should return null when the launch tool id is missing", () => {
    // Without the tool_use_id we can't attach the card to a tool call —
    // drop it rather than render an orphan.
    const frame = makeFrame(SESSION_WORKFLOW_PROGRESS_EVENT, {
      run_id: "wf_x",
      state: "{}",
    });
    expect(parseWorkflowProgress(frame)).toBeNull();
  });

  it("should fall back to defaults when state is malformed JSON", () => {
    // A malformed snapshot still yields a usable (empty) state rather than
    // crashing the SSE handler — the card shows a 0/0 running shell.
    const frame = makeFrame(SESSION_WORKFLOW_PROGRESS_EVENT, {
      id: "tool-wf",
      run_id: "wf_x",
      state: "{not json",
    });

    const parsed = parseWorkflowProgress(frame);

    expect(parsed).not.toBeNull();
    expect(parsed!.state.runId).toBe("wf_x");
    expect(parsed!.state.status).toBe("running");
    expect(parsed!.state.agentCount).toBe(0);
    expect(parsed!.state.workflowProgress).toEqual([]);
  });

  it("should drop agent entries without an agentId", () => {
    const state = {
      runId: "wf_a",
      status: "running",
      agentCount: 1,
      agentsDone: 0,
      workflowProgress: [
        { type: "workflow_agent", state: "progress" }, // no agentId → dropped
        { type: "workflow_agent", agentId: "good", state: "progress" },
      ],
    };
    const frame = makeFrame(SESSION_WORKFLOW_PROGRESS_EVENT, {
      id: "tool-wf",
      run_id: "wf_a",
      state: JSON.stringify(state),
    });

    const parsed = parseWorkflowProgress(frame);

    expect(parsed!.state.workflowProgress).toEqual([
      { type: "workflow_agent", agentId: "good", state: "progress", label: undefined, phase: undefined },
    ]);
  });

  it("should carry the terminal completed status through", () => {
    const state = {
      runId: "wf_done",
      workflowName: "audit",
      status: "completed",
      agentCount: 5,
      agentsDone: 5,
      workflowProgress: [],
    };
    const frame = makeFrame(SESSION_WORKFLOW_PROGRESS_EVENT, {
      id: "tool-wf",
      run_id: "wf_done",
      state: JSON.stringify(state),
    });

    const parsed = parseWorkflowProgress(frame);

    expect(parsed!.state.status).toBe("completed");
    expect(parsed!.state.agentsDone).toBe(5);
  });

  it("should surface the result question/summary and state-file path", () => {
    const state = {
      runId: "wf_done",
      status: "completed",
      agentCount: 5,
      agentsDone: 5,
      workflowProgress: [],
      resultQuestion: "What is X?",
      resultSummary: "X is the answer.",
      statePath: "/p/workflows/wf_done.json",
    };
    const frame = makeFrame(SESSION_WORKFLOW_PROGRESS_EVENT, {
      id: "tool-wf",
      run_id: "wf_done",
      state: JSON.stringify(state),
    });

    const parsed = parseWorkflowProgress(frame);

    expect(parsed!.state.resultQuestion).toBe("What is X?");
    expect(parsed!.state.resultSummary).toBe("X is the answer.");
    expect(parsed!.state.statePath).toBe("/p/workflows/wf_done.json");
  });

  it("should leave result fields undefined when absent (live snapshot)", () => {
    const state = {
      runId: "wf_live",
      status: "running",
      agentCount: 2,
      agentsDone: 0,
      workflowProgress: [],
    };
    const frame = makeFrame(SESSION_WORKFLOW_PROGRESS_EVENT, {
      id: "tool-wf",
      run_id: "wf_live",
      state: JSON.stringify(state),
    });

    const parsed = parseWorkflowProgress(frame);

    expect(parsed!.state.resultQuestion).toBeUndefined();
    expect(parsed!.state.resultSummary).toBeUndefined();
    expect(parsed!.state.statePath).toBeUndefined();
  });
});
