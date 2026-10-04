/**
 * Scroll-position anchoring for an auto-refreshing list (plan §4B / §7.4).
 *
 * The project-detail "All" tab re-sorts sessions + tasks by ``updated_at`` on
 * the client, and a task status change rewrites ``updated_at`` — so a poll tick
 * can reorder already-visible rows. A stable ``key`` only moves DOM nodes; it
 * does not stop the row the user is looking at from jumping. This hook keeps
 * that row visually pinned WITHOUT touching the sort rules:
 *
 *  1. As the user scrolls (passive listener) and after every commit, it records
 *     the first visible row's ``data-anchor-key`` and its top offset relative
 *     to the scroll container.
 *  2. After a data change (``useLayoutEffect`` keyed on ``dataKey``, before the
 *     browser paints) it finds that row again, measures its new offset, and
 *     adjusts ``scrollTop`` by the delta — snapping the row back to where it
 *     was.
 *
 * Top exemption: when the user is at (or within ``TOP_EXEMPTION_PX`` of) the
 * top, no correction runs, so genuinely new/reordered rows surface naturally
 * (PRD §9.1/§9.2). If the anchor row was removed, it falls back to recomputing
 * the anchor and skips the correction — it never throws.
 *
 * IMPORTANT (plan review P2): the project-detail page has no list-level
 * ``overflow-y-auto``; the real scroller is the layout's content container
 * (``ProjectLayoutBase`` ``contentClassName="overflow-y-auto"``). Pass a ref to
 * the element that actually scrolls — writing ``scrollTop`` on a non-scrolling
 * element is a no-op.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/** Within this many px of the top, skip correction so new rows show. */
const TOP_EXEMPTION_PX = 8;

interface Anchor {
  key: string;
  /** Row top relative to the scroll container's top edge (px). */
  top: number;
}

function rowOffsetTop(container: HTMLElement, row: HTMLElement): number {
  return row.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

/** The first row at least partially visible below the container's top edge. */
function firstVisibleAnchor(container: HTMLElement): Anchor | null {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>("[data-anchor-key]"),
  );
  const containerTop = container.getBoundingClientRect().top;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > containerTop) {
      const key = row.getAttribute("data-anchor-key");
      if (key) return { key, top: rect.top - containerTop };
    }
  }
  return null;
}

function selectByAnchorKey(
  container: HTMLElement,
  key: string,
): HTMLElement | null {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(key)
      : key.replace(/["\\]/g, "\\$&");
  return container.querySelector<HTMLElement>(`[data-anchor-key="${escaped}"]`);
}

/**
 * @param scrollContainerRef ref to the element that actually scrolls.
 * @param dataKey a fingerprint of the rendered list (e.g. row keys + each
 *   row's ``updated_at``); a change re-runs the correction layout effect.
 */
export function useListScrollAnchor(
  scrollContainerRef: RefObject<HTMLElement | null>,
  dataKey: string | number,
): void {
  const anchorRef = useRef<Anchor | null>(null);

  const captureAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    anchorRef.current = firstVisibleAnchor(container);
  }, [scrollContainerRef]);

  // Keep the anchor fresh as the user scrolls so the next data change measures
  // from the user's current position.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const onScroll = (): void => captureAnchor();
    container.addEventListener("scroll", onScroll, { passive: true });
    captureAnchor();
    return () => container.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef, captureAnchor]);

  // Before paint after a data change: restore the anchor row's visual position.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const anchor = anchorRef.current;
    if (!container || !anchor) {
      captureAnchor();
      return;
    }
    // Top exemption: let new/reordered rows surface naturally at the top.
    if (container.scrollTop <= TOP_EXEMPTION_PX) {
      captureAnchor();
      return;
    }
    const row = selectByAnchorKey(container, anchor.key);
    if (!row) {
      // Anchor row gone (deleted / filtered out): don't correct, just
      // recompute a fresh anchor for next time. Never throw.
      captureAnchor();
      return;
    }
    const delta = rowOffsetTop(container, row) - anchor.top;
    if (delta !== 0) container.scrollTop += delta;
    // Re-capture from the corrected position so consecutive changes compound
    // correctly.
    captureAnchor();
    // ``captureAnchor`` is stable; only re-run when the list data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey]);
}
