import { describe, expect, it } from "vitest";
import { outletTransitionKey } from "./outlet-key";

describe("outletTransitionKey", () => {
  it("keeps one key across the new → real-id promotion", () => {
    // Regression: a changed key here remounts ConversationPage mid-send,
    // resetting the promote fast-path refs and killing the live SSE.
    expect(outletTransitionKey("/conversation/new")).toBe(
      outletTransitionKey("/conversation/abc123"),
    );
  });

  it("keeps one key across session switches", () => {
    expect(outletTransitionKey("/conversation/a")).toBe(
      outletTransitionKey("/conversation/b"),
    );
  });

  it("still remounts between different page families", () => {
    expect(outletTransitionKey("/conversation/a")).not.toBe(
      outletTransitionKey("/agents"),
    );
    expect(outletTransitionKey("/projects/p1")).not.toBe(
      outletTransitionKey("/projects/p2"),
    );
  });
});
