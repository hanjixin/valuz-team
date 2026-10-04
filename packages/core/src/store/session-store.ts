import { create } from "zustand";
import type { SessionListItem } from "@valuz/shared";
import { sessionsApi } from "../api/sessions-api";
import { resolveApiBase } from "../api/base-resolver";
import { getEntityOrigin, recordEntityOrigin } from "../edition/entity-origin";

interface SessionStoreState {
  sessions: SessionListItem[];
  activeSessionId: string | null;
  /** The project that owns the conversation currently open in the main view,
   *  published by the conversation page from its loaded session detail. This is
   *  the authoritative, immediate answer to "which project am I in?" — used by
   *  the sidebar to keep that project's accordion expanded. ``null`` when the
   *  open conversation is project-less or no conversation is open. */
  activeProjectId: string | null;
  loading: boolean;

  setSessions: (sessions: SessionListItem[]) => void;
  setActiveSession: (sessionId: string | null) => void;
  setActiveProjectId: (projectId: string | null) => void;

  fetchSessions: (projectId?: string) => Promise<void>;
  /**
   * Merge a fresh, full snapshot of ONE project's sessions into the global
   * list without disturbing any other project's rows. Used by the
   * project-detail auto-refresh poller (``useProjectListAutoRefresh``): the
   * project list endpoint returns the whole project subset every tick, so we
   * replace exactly that subset (drop rows that disappeared, upsert
   * changed/new rows, keep every other project's rows untouched) instead of
   * ``set({ sessions })`` which would narrow the global store to a single
   * project and break the cross-project sidebar.
   *
   * Same-source guard: rows whose ``project_id`` isn't ``projectId`` are
   * dropped — a stale/cross-project response must never leak into this slice.
   * Unchanged rows keep their previous object reference so memoised selectors
   * don't re-render needlessly.
   */
  mergeProjectSessions: (projectId: string, items: SessionListItem[]) => void;
  createSession: (
    projectId: string,
    title?: string,
  ) => Promise<SessionListItem>;
  renameSession: (sessionId: string, name: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
}

// Flat field set compared to decide whether an incoming row is unchanged from
// the one already in the store (so we can reuse the old reference).
const SESSION_ROW_KEYS: (keyof SessionListItem)[] = [
  "id",
  "project_id",
  "name",
  "status",
  "origin",
  "last_user_message_text",
  "locked_model_id",
  "locked_provider_id",
  "runtime_provider",
  "permission_mode",
  "effort",
  "task_id",
  "updated_at",
];

function sessionRowEqual(a: SessionListItem, b: SessionListItem): boolean {
  return SESSION_ROW_KEYS.every((k) => a[k] === b[k]);
}

export const useSessionStore = create<SessionStoreState>((set) => ({
  sessions: [],
  activeSessionId: null,
  activeProjectId: null,
  loading: false,

  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (activeSessionId) => set({ activeSessionId }),
  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),

  fetchSessions: async (projectId?: string) => {
    set({ loading: true });
    try {
      const { sessions } = await sessionsApi.list(projectId);
      set({ sessions });
    } finally {
      set({ loading: false });
    }
  },

  mergeProjectSessions: (projectId, items) =>
    set((state) => {
      // Same-source guard: only rows that actually belong to ``projectId`` may
      // be written into this project's slice. A row from another project is a
      // stale/cross-project response — drop it rather than leak it here.
      const incoming = items.filter((it) => it.project_id === projectId);

      const prevById = new Map<string, SessionListItem>();
      for (const s of state.sessions) {
        if (s.project_id === projectId) prevById.set(s.id, s);
      }

      // Upsert each incoming row, reusing the previous object reference when
      // nothing changed so memoised per-row selectors don't re-render.
      const mergedProjectRows = incoming.map((it) => {
        const prev = prevById.get(it.id);
        return prev && sessionRowEqual(prev, it) ? prev : it;
      });

      // Re-assemble the global array: other projects' rows stay exactly where
      // they were; this project's rows are replaced in-place by the merged
      // subset (disappeared rows dropped, changed/new rows upserted).
      const next: SessionListItem[] = [];
      let emitted = false;
      for (const s of state.sessions) {
        if (s.project_id !== projectId) {
          next.push(s);
          continue;
        }
        if (!emitted) {
          next.push(...mergedProjectRows);
          emitted = true;
        }
        // Old rows of this project are represented by ``mergedProjectRows`` —
        // skip them here so disappeared rows fall away.
      }
      // First data for a project that had no rows yet → append at the end.
      if (!emitted) next.push(...mergedProjectRows);

      // No-op detection: if the array is element-wise identical, keep the old
      // reference so subscribers don't re-render.
      if (
        next.length === state.sessions.length &&
        next.every((s, i) => s === state.sessions[i])
      ) {
        return {};
      }
      return { sessions: next };
    }),

  createSession: async (projectId: string, title?: string) => {
    // Project sessions follow the project's execution origin (multi-target
    // editions; "" -> module default, unchanged for OSS single-backend).
    const projectBaseUrl = resolveApiBase({ projectId }, "");
    const detail = await sessionsApi.create(
      {
        project_id: projectId,
        title,
      },
      projectBaseUrl ? { baseUrl: projectBaseUrl } : undefined,
    );
    const projectOrigin = getEntityOrigin(projectId, "project");
    if (projectOrigin) recordEntityOrigin(detail.id, projectOrigin);
    const item: SessionListItem = {
      id: detail.id,
      project_id: detail.project_id,
      name: detail.name,
      status: detail.status,
      origin: detail.origin,
      last_user_message_text: detail.last_user_message_text,
      locked_model_id: detail.locked_model_id,
      locked_provider_id: detail.locked_provider_id ?? null,
      runtime_provider: detail.runtime_provider,
      permission_mode: detail.permission_mode,
      effort: detail.effort ?? null,
      // A freshly-created session is always user-initiated (the
      // ``sessions.create`` endpoint is what the composer/sidebar
      // calls). Task-internal sessions are spawned server-side by
      // the orchestrator and never round-trip through this store.
      task_id: null,
      updated_at: detail.updated_at,
    };
    set((state) => ({ sessions: [item, ...state.sessions] }));
    return item;
  },

  renameSession: async (sessionId: string, name: string) => {
    await sessionsApi.rename(sessionId, name);
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, name } : s,
      ),
    }));
  },

  deleteSession: async (sessionId: string) => {
    await sessionsApi.delete(sessionId);
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== sessionId),
      activeSessionId:
        state.activeSessionId === sessionId ? null : state.activeSessionId,
    }));
  },
}));
