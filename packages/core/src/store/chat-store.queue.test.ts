import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueResult = {
  session_id: "s",
  items: [
    {
      id: "q1",
      status: "queued",
      position: 0,
      text: "follow-up",
      attachment_count: 0,
      provider_id: null,
      model_id: null,
      error_message: null,
      created_at: 1,
      updated_at: null,
    },
  ],
  paused: false,
};

vi.mock("../api/queue-api", () => ({
  queueApi: {
    enqueue: vi.fn(async () => enqueueResult),
    list: vi.fn(async () => ({ session_id: "s", items: [], paused: false })),
    edit: vi.fn(async () => ({ session_id: "s", items: [], paused: false })),
    remove: vi.fn(async () => ({ session_id: "s", items: [], paused: false })),
    resume: vi.fn(async () => ({ session_id: "s", items: [], paused: false })),
    steer: vi.fn(async () => ({ session_id: "s", items: [], paused: false })),
  },
}));

vi.mock("../api/sessions-api", () => ({
  sessionsApi: { sendMessage: vi.fn(async () => ({})) },
  parseTodosUpdate: () => null,
}));

import { queueApi } from "../api/queue-api";
import { sessionsApi } from "../api/sessions-api";
import { useChatStore } from "./chat-store";

describe("chat-store input queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      sessionId: "s",
      isStreaming: false,
      queue: [],
      queuePaused: false,
      messages: [],
    });
  });

  it("routes send → enqueue while a turn is streaming", async () => {
    useChatStore.setState({ isStreaming: true });
    await useChatStore.getState().send("follow-up");

    expect(queueApi.enqueue).toHaveBeenCalledTimes(1);
    expect(sessionsApi.sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().queue).toHaveLength(1);
    expect(useChatStore.getState().queue[0]!.text).toBe("follow-up");
  });

  it("sends normally (no enqueue) when idle", async () => {
    useChatStore.setState({ isStreaming: false });
    await useChatStore.getState().send("hello");

    expect(sessionsApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(queueApi.enqueue).not.toHaveBeenCalled();
  });

  it("refetches the queue on a turn boundary (streaming → idle)", async () => {
    useChatStore.setState({ isStreaming: true });
    useChatStore.getState()._ingest({
      seq: 1,
      event: { event_type: "session.idle", payload: {} },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(queueApi.list).toHaveBeenCalledWith("s");
  });

  it("does not refetch when no boundary is crossed", async () => {
    useChatStore.setState({ isStreaming: true });
    useChatStore.getState()._ingest({
      seq: 2,
      event: { event_type: "message.assistant.text_delta", payload: { text: "x" } },
    });
    await Promise.resolve();
    expect(queueApi.list).not.toHaveBeenCalled();
  });

  it("resumeQueue updates queue + paused from the response", async () => {
    (queueApi.resume as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      session_id: "s",
      items: [],
      paused: false,
    });
    useChatStore.setState({ queuePaused: true });
    await useChatStore.getState().resumeQueue();
    expect(queueApi.resume).toHaveBeenCalledWith("s");
    expect(useChatStore.getState().queuePaused).toBe(false);
  });

  it("steerQueued sends the item now and syncs queue + paused", async () => {
    (queueApi.steer as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      session_id: "s",
      items: [],
      paused: false,
    });
    useChatStore.setState({ queuePaused: true });
    await useChatStore.getState().steerQueued("q1");
    expect(queueApi.steer).toHaveBeenCalledWith("s", "q1");
    expect(useChatStore.getState().queue).toHaveLength(0);
    expect(useChatStore.getState().queuePaused).toBe(false);
  });
});
