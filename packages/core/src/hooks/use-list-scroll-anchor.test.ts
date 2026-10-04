/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

import { useListScrollAnchor } from "./use-list-scroll-anchor";

const ROW_H = 20;

let container: HTMLElement;
let scrollTop = 0;

function makeRow(key: string): HTMLElement {
  const li = document.createElement("li");
  li.setAttribute("data-anchor-key", key);
  return li;
}

/** Model each row's rect from its live DOM order and the current scrollTop:
 *  row i sits at top = i*ROW_H - scrollTop (container top = 0). */
function installLayout(keys: string[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  for (const k of keys) container.appendChild(makeRow(k));

  scrollTop = 0;
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this === container) {
        return { top: 0, bottom: 1000, height: 1000 } as DOMRect;
      }
      const rows = Array.from(
        container.querySelectorAll<HTMLElement>("[data-anchor-key]"),
      );
      const idx = rows.indexOf(this);
      const top = idx * ROW_H - scrollTop;
      return { top, bottom: top + ROW_H, height: ROW_H } as DOMRect;
    },
  );
}

const ref = (): RefObject<HTMLElement | null> => ({ current: container });

const scroll = () => {
  container.dispatchEvent(new Event("scroll"));
};

describe("useListScrollAnchor", () => {
  beforeEach(() => {
    installLayout(["r1", "r2", "r3", "r4", "r5"]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    container.remove();
  });

  it("corrects scrollTop so the first visible row stays put after a reorder", async () => {
    const { rerender } = renderHook(
      ({ k }: { k: string }) => useListScrollAnchor(ref(), k),
      { initialProps: { k: "v1" } },
    );
    // User scrolls down; first visible row becomes r3 (idx 2, top -10).
    await act(async () => {
      scrollTop = 50;
      scroll();
    });
    // Data update prepends a new row → r3 shifts down to idx 3 (top 10).
    container.insertBefore(makeRow("r0"), container.firstChild);
    await act(async () => {
      rerender({ k: "v2" });
    });
    // Correction pushed scrollTop by +20 (10 - (-10)) so r3's top is -10 again.
    expect(scrollTop).toBe(70);
    const r3 = container.querySelector<HTMLElement>('[data-anchor-key="r3"]')!;
    expect(r3.getBoundingClientRect().top).toBe(-10);
  });

  it("does not correct while the user is at the top (top exemption)", async () => {
    const { rerender } = renderHook(
      ({ k }: { k: string }) => useListScrollAnchor(ref(), k),
      { initialProps: { k: "v1" } },
    );
    await act(async () => {
      scrollTop = 4; // within the ~8px exemption band
      scroll();
    });
    container.insertBefore(makeRow("r0"), container.firstChild);
    await act(async () => {
      rerender({ k: "v2" });
    });
    expect(scrollTop).toBe(4); // untouched → new row visible at the top
  });

  it("falls back to no correction (no throw) when the anchor row is removed", async () => {
    const { rerender } = renderHook(
      ({ k }: { k: string }) => useListScrollAnchor(ref(), k),
      { initialProps: { k: "v1" } },
    );
    await act(async () => {
      scrollTop = 50; // anchor becomes r3
      scroll();
    });
    container.querySelector('[data-anchor-key="r3"]')!.remove();
    expect(() => {
      act(() => {
        rerender({ k: "v2" });
      });
    }).not.toThrow();
    expect(scrollTop).toBe(50); // no correction applied
  });

  it("no-ops safely when the container ref is null", () => {
    const nullRef: RefObject<HTMLElement | null> = { current: null };
    expect(() =>
      renderHook(() => useListScrollAnchor(nullRef, "v1")),
    ).not.toThrow();
  });
});
