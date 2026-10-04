import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  getEntityOrigin,
  recordEntityOrigin,
  setEntityOriginAdapter,
  useEntityOrigin,
} from "./entity-origin";

afterEach(() => {
  setEntityOriginAdapter(null);
});

describe("entity origin seam", () => {
  it("is a no-op without an adapter (OSS single-backend)", () => {
    expect(getEntityOrigin("s1")).toBeUndefined();
    expect(() => recordEntityOrigin("s1", "cloud")).not.toThrow();
  });

  it("delegates lookup and record to the adapter", () => {
    const store = new Map<string, string>();
    setEntityOriginAdapter({
      lookup: (id) => store.get(id),
      record: (id, targetId) => store.set(id, targetId),
    });
    recordEntityOrigin("s1", "cloud");
    expect(getEntityOrigin("s1")).toBe("cloud");
    expect(getEntityOrigin("unknown")).toBeUndefined();
  });

  it("passes the kind hint through to the adapter lookup", () => {
    const lookup = vi.fn().mockReturnValue(undefined);
    setEntityOriginAdapter({ lookup, record: () => {} });
    getEntityOrigin("p1", "project");
    expect(lookup).toHaveBeenCalledWith("p1", "project");
  });

  it("useEntityOrigin re-renders when an observation lands", () => {
    const store = new Map<string, string>();
    setEntityOriginAdapter({
      lookup: (id) => store.get(id),
      record: (id, targetId) => store.set(id, targetId),
    });
    const { result } = renderHook(() => useEntityOrigin("s1", "session"));
    expect(result.current).toBeUndefined();
    act(() => {
      recordEntityOrigin("s1", "cloud");
    });
    expect(result.current).toBe("cloud");
  });

  it("useEntityOrigin returns undefined for a null id", () => {
    setEntityOriginAdapter({
      lookup: () => "cloud",
      record: () => {},
    });
    const { result } = renderHook(() => useEntityOrigin(null));
    expect(result.current).toBeUndefined();
  });
});
