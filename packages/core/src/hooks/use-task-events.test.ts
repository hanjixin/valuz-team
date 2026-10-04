/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchEventSource, type SSEFrame } from "../api/fetch-event-source";
import { useTaskEvents } from "./use-task-events";

vi.mock("../api/fetch-event-source", () => ({
  fetchEventSource: vi.fn(() => vi.fn()),
}));

const mockFetchEventSource = vi.mocked(fetchEventSource);

const lastCall = (): {
  getUrl: () => string;
  onFrame: (frame: SSEFrame) => void;
} => {
  const call = mockFetchEventSource.mock.calls.at(-1);
  if (!call) throw new Error("fetchEventSource was not called");
  return { getUrl: call[0], onFrame: call[1] };
};

describe("useTaskEvents", () => {
  beforeEach(() => {
    mockFetchEventSource.mockReset();
    mockFetchEventSource.mockImplementation(() => vi.fn());
  });

  it("is inert when taskId is null", () => {
    renderHook(() => useTaskEvents(null, vi.fn()));
    expect(mockFetchEventSource).not.toHaveBeenCalled();
  });

  it("delivers parsed events and threads the seq cursor into the URL", () => {
    const onEvent = vi.fn();
    renderHook(() => useTaskEvents("t1", onEvent));
    const { getUrl, onFrame } = lastCall();
    expect(getUrl()).toContain("/v1/tasks/t1/events/stream");
    expect(getUrl()).not.toContain("keep_alive");

    act(() => {
      onFrame({
        event: "task_planned",
        data: JSON.stringify({ id: "e1", sequence: 7, type: "task_planned" }),
        id: "7",
      });
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(getUrl()).toContain("after_seq=7");
  });

  it("ignores heartbeat frames", () => {
    const onEvent = vi.fn();
    renderHook(() => useTaskEvents("t1", onEvent));
    lastCall().onFrame({ event: "heartbeat", data: "", id: null });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("closes for good on stream_end instead of reconnect-looping", () => {
    const close = vi.fn();
    mockFetchEventSource.mockImplementation(() => close);
    const onEvent = vi.fn();
    renderHook(() => useTaskEvents("t1", onEvent));

    lastCall().onFrame({ event: "stream_end", data: "", id: null });

    expect(close).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("threads keepAlive into the stream URL", () => {
    renderHook(() => useTaskEvents("t1", vi.fn(), { keepAlive: true }));
    expect(lastCall().getUrl()).toContain("keep_alive=1");
  });

  it("closes the stream on unmount", () => {
    const close = vi.fn();
    mockFetchEventSource.mockImplementation(() => close);
    const { unmount } = renderHook(() => useTaskEvents("t1", vi.fn()));
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
