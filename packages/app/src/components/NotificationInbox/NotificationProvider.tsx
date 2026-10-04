/**
 * Mount-once provider for the unified notification ledger
 * (docs/design/notifications.md).
 *
 * Drives EVERY delivery channel from the ONE store — no parallel subscriptions:
 * - in-app ``toast.info`` per fresh notification (visible only when in-app);
 * - OS native notification + dock bounce + dock badge (the "强提醒" for when the
 *   window is hidden / tray-resident) — Electron only, no-op on web;
 * - navigation on notification click.
 *
 * A "fresh" notification (store ``freshIds`` — set on live ``added`` / a
 * reconnect snapshot for an unseen unread item) alerts exactly once, then is
 * marked alerted so a resolve→re-add or reconnect never re-alerts. Renders
 * ``null``.
 */

import { useEffect, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { useNotificationInbox, useNotificationStore } from "@valuz/core";

import { notificationDisplay } from "./notification-display";

interface DesktopBridge {
  invoke: <T>(channel: string, args?: unknown) => Promise<T>;
  on: (event: string, handler: (payload: unknown) => void) => void;
  off: (event: string, handler: (payload: unknown) => void) => void;
}

function getBridge(): DesktopBridge | null {
  return (
    (window as Window & { valuzDesktop?: DesktopBridge }).valuzDesktop ?? null
  );
}

/**
 * True when the user is currently looking at the page a notification deep-links
 * to. Desktop uses a HashRouter, so the active path lives in ``location.hash``
 * (e.g. ``#/conversation/abc``); webui uses the pathname. We check both so this
 * works in either host. Lenient exact-match after stripping query/trailing
 * slash — enough to tell "on this conversation" from "somewhere else".
 */
function isCurrentRoute(route: string | null | undefined): boolean {
  if (!route) return false;
  const norm = (p: string) => p.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const target = norm(route);
  const hash = window.location.hash || "";
  const fromHash = hash.startsWith("#") ? hash.slice(1) : "";
  return norm(fromHash) === target || norm(window.location.pathname) === target;
}

export function NotificationProvider(): ReactElement | null {
  const navigate = useNavigate();
  // Singleton subscription (idempotent).
  useNotificationInbox();

  useEffect(() => {
    const bridge = getBridge();

    // Click on a native notification → navigate to its route.
    const onClick = (payload: unknown) => {
      const route = (payload as { route?: string } | null)?.route;
      if (typeof route === "string" && route) navigate(route);
    };
    bridge?.on("notification-clicked", onClick);

    const unsub = useNotificationStore.subscribe((state) => {
      // Badge = unread count (open && not read), always consistent with the list.
      const unread = Array.from(state.entries.values()).filter(
        (e) => e.read_at == null,
      ).length;
      void bridge?.invoke("desktop_set_badge_count", { count: unread });

      if (state.freshIds.size === 0) return;
      for (const id of state.freshIds) {
        const entry = state.entries.get(id);
        if (!entry) {
          state.markAlerted(id);
          continue;
        }
        const d = notificationDisplay(entry);
        // Mark first so a re-entrant subscribe (from markAlerted's own set())
        // doesn't double-fire.
        state.markAlerted(id);
        // Presence is a CLIENT fact the backend can't know, so the delivery
        // CHANNEL is decided here, by where the user actually is:
        //   - focused AND already on this item's page → fully silent (the
        //     inline card is right there);
        //   - focused but elsewhere in the app → in-app toast only;
        //   - blurred / tray-resident / another app → OS notification + dock
        //     bounce (the "强提醒").
        // This gates ONLY the alert channels. Read/unread, the badge, and the
        // drawer are driven by the ledger entry and are deliberately untouched.
        const focused = document.hasFocus();
        const onScene = focused && isCurrentRoute(d.route);
        // In-app toast — skipped only when the user is already on the page.
        if (!onScene) {
          toast.info(d.title, { description: d.body || undefined });
        }
        // OS notification + dock bounce — only when the window isn't focused.
        // ``info`` urgency (e.g. a future completion notice) stays in-app only.
        if (bridge && entry.urgency !== "info" && !focused) {
          void bridge.invoke("desktop_notify", {
            title: d.title,
            body: d.body,
            route: d.route,
            tag: d.tag,
          });
          void bridge.invoke("desktop_bounce", {});
        }
      }
    });

    // Prime the badge from the current snapshot.
    const initial = Array.from(
      useNotificationStore.getState().entries.values(),
    ).filter((e) => e.read_at == null).length;
    void bridge?.invoke("desktop_set_badge_count", { count: initial });

    return () => {
      bridge?.off("notification-clicked", onClick);
      unsub();
    };
  }, [navigate]);

  return null;
}
