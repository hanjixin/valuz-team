/**
 * Notification Zustand store (docs/design/notifications.md).
 *
 * Single source of truth for the unified attention ledger across the app —
 * questions + task failures. The singleton ``useNotifications`` hook writes;
 * components read via selectors. Toast / OS-notify / dock-badge emission lives
 * in the Provider, not the store (framework-agnostic).
 *
 * Holds only OPEN (unresolved) notifications, keyed by ``id``. ``unread`` is
 * derived (``read_at == null``) so the badge is always consistent with the
 * list — no separate counter to drift.
 */

import { useMemo } from "react";
import { create } from "zustand";

import type { NotificationEntry } from "../api/notifications-api";

interface NotificationStoreState {
  /** Open entries keyed by id. */
  entries: Map<string, NotificationEntry>;
  /** ids the user hasn't been alerted for yet (drives Provider toast/notify). */
  freshIds: Set<string>;
  /** ids the Provider already alerted, so a resolve→re-add or reconnect
   *  snapshot doesn't re-alert. */
  alertedIds: Set<string>;
  isOpen: boolean;
  _inited: boolean;
  _everReset: boolean;

  reset: (entries: NotificationEntry[]) => void;
  add: (entry: NotificationEntry) => void;
  update: (entry: NotificationEntry) => void;
  remove: (id: string) => void;
  markAlerted: (id: string) => void;
  clearFresh: () => void;
  setOpen: (open: boolean) => void;
  setInited: () => void;
}

export const useNotificationStore = create<NotificationStoreState>((set) => ({
  entries: new Map(),
  freshIds: new Set(),
  alertedIds: new Set(),
  isOpen: false,
  _inited: false,
  _everReset: false,

  reset: (list) =>
    set((state) => {
      // Diff-aware no-op so the poll backstop / reconnect snapshot doesn't mint
      // a fresh Map every tick.
      if (
        state._everReset &&
        list.length === state.entries.size &&
        list.every((e) => state.entries.has(e.id))
      ) {
        return {};
      }
      const entries = new Map<string, NotificationEntry>();
      const freshIds = new Set<string>();
      for (const e of list) {
        entries.set(e.id, e);
        // An entry we never held, arriving via a later snapshot (reconnect /
        // poll), IS news — unless it's already read (came in while offline and
        // was auto-read) or we've alerted it before.
        if (
          state._everReset &&
          !state.entries.has(e.id) &&
          e.read_at == null &&
          !state.alertedIds.has(e.id)
        ) {
          freshIds.add(e.id);
        } else if (state.freshIds.has(e.id)) {
          freshIds.add(e.id);
        }
      }
      return { entries, freshIds, _everReset: true };
    }),

  add: (entry) =>
    set((state) => {
      const entries = new Map(state.entries);
      entries.set(entry.id, entry);
      const freshIds = new Set(state.freshIds);
      if (!state.alertedIds.has(entry.id)) freshIds.add(entry.id);
      return { entries, freshIds };
    }),

  update: (entry) =>
    set((state) => {
      if (!state.entries.has(entry.id)) return {};
      const entries = new Map(state.entries);
      entries.set(entry.id, entry);
      return { entries };
    }),

  remove: (id) =>
    set((state) => {
      if (!state.entries.has(id)) return {};
      const entries = new Map(state.entries);
      entries.delete(id);
      const freshIds = new Set(state.freshIds);
      freshIds.delete(id);
      return { entries, freshIds };
    }),

  markAlerted: (id) =>
    set((state) => {
      const alertedIds = new Set(state.alertedIds);
      alertedIds.add(id);
      const freshIds = new Set(state.freshIds);
      freshIds.delete(id);
      return { alertedIds, freshIds };
    }),

  clearFresh: () =>
    set((state) => (state.freshIds.size === 0 ? {} : { freshIds: new Set() })),

  setOpen: (isOpen) => set({ isOpen }),
  setInited: () => set({ _inited: true }),
}));

// ---- Selectors --------------------------------------------------

/** Open notifications, newest first (drawer reading order). */
export const useNotifications = (): NotificationEntry[] => {
  const entries = useNotificationStore((s) => s.entries);
  return useMemo(
    () => Array.from(entries.values()).sort((a, b) => b.created_at - a.created_at),
    [entries],
  );
};

/** Unread count (open && not read) — the badge number. */
export const useNotificationUnreadCount = (): number => {
  const entries = useNotificationStore((s) => s.entries);
  return useMemo(
    () => Array.from(entries.values()).filter((e) => e.read_at == null).length,
    [entries],
  );
};

export const useNotificationTotalCount = (): number =>
  useNotificationStore((s) => s.entries.size);

export const useNotificationIsOpen = (): boolean =>
  useNotificationStore((s) => s.isOpen);
