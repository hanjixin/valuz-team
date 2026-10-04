import { afterEach, describe, expect, it } from "vitest";
import { resolveApiBase, setApiBaseResolver } from "./base-resolver";

const FALLBACK = "http://localhost:8000";

afterEach(() => {
  setApiBaseResolver(null);
});

describe("resolveApiBase", () => {
  it("returns the fallback when no resolver is registered", () => {
    expect(resolveApiBase({ sessionId: "s1" }, FALLBACK)).toBe(FALLBACK);
  });

  it("returns the resolver's base for a known entity", () => {
    setApiBaseResolver((ref) =>
      ref.sessionId === "cloud-session" ? "http://cloud:8010" : undefined,
    );
    expect(resolveApiBase({ sessionId: "cloud-session" }, FALLBACK)).toBe(
      "http://cloud:8010",
    );
  });

  it("falls back when the resolver has no opinion (undefined)", () => {
    setApiBaseResolver(() => undefined);
    expect(resolveApiBase({ projectId: "p1" }, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when the resolver throws", () => {
    setApiBaseResolver(() => {
      throw new Error("boom");
    });
    expect(resolveApiBase({ taskId: "t1" }, FALLBACK)).toBe(FALLBACK);
  });

  it("clears back to fallback after setApiBaseResolver(null)", () => {
    setApiBaseResolver(() => "http://cloud:8010");
    expect(resolveApiBase({ sessionId: "s1" }, FALLBACK)).toBe(
      "http://cloud:8010",
    );
    setApiBaseResolver(null);
    expect(resolveApiBase({ sessionId: "s1" }, FALLBACK)).toBe(FALLBACK);
  });

  it("passes the full ref through so resolvers can branch per entity kind", () => {
    setApiBaseResolver((ref) => {
      if (ref.projectId === "cloud-project") return "http://cloud:8010";
      if (ref.taskId === "cloud-task") return "http://cloud:8010";
      return undefined;
    });
    expect(resolveApiBase({ projectId: "cloud-project" }, FALLBACK)).toBe(
      "http://cloud:8010",
    );
    expect(resolveApiBase({ taskId: "cloud-task" }, FALLBACK)).toBe(
      "http://cloud:8010",
    );
    expect(resolveApiBase({ projectId: "local-project" }, FALLBACK)).toBe(
      FALLBACK,
    );
  });
});
