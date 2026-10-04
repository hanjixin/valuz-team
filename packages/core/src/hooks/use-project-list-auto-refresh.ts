/**
 * Page-scoped focus poller that keeps a project-detail page's two centre
 * lists (sessions + lead-dispatch tasks) fresh while the user stays on the
 * page (PRD ``project-detail-auto-refresh`` §6; plan §4A).
 *
 * Mechanism: every ``intervalMs`` (default 4s, satisfying the 5s SLA) — and
 * immediately on ``visibilitychange→visible`` / ``online`` — it re-fetches the
 * two already-``user_id``+``project_id``-filtered list endpoints and writes
 * the whole snapshot back (sessions via ``mergeProjectSessions``, tasks via the
 * ``onTasks`` callback). Because every tick pulls the FULL list, recovery from
 * a failed/aborted tick needs no cursor: the next ``fulfilled`` tick backfills
 * everything missed (plan §4A.6 / §9.6).
 *
 * Execution contract (plan §4A):
 *  - single-flight per ``projectId`` (``inFlight``) — an overlapping tick is
 *    skipped, never queued;
 *  - one ``AbortController`` per tick; cleanup (unmount / ``projectId`` change)
 *    aborts the in-flight request, clears the interval, and drops listeners;
 *  - a ``setTimeout(intervalMs) → abort`` bounds a hung request to one interval
 *    (``createFetchJson`` has no REST timeout) so a stuck fetch can't block the
 *    next recovery tick;
 *  - generation guard: each effect instance is one generation. On a
 *    ``projectId`` switch React tears the old effect down (``stopped = true`` +
 *    ``abort``), so a late response from project A can never write into project
 *    B's page state;
 *  - sessions + tasks run in parallel via ``Promise.allSettled`` — one side
 *    failing leaves the other side's write (and the failed side's last good
 *    list) untouched.
 *
 * This hook owns ONLY the steady-state refresh. First load stays with the
 * existing mount fetches (``ProjectDetailPage`` task fetch + ``ProjectLayoutBase``
 * ``fetchSessions``); both paths are full-table + id-keyed merges, so they're
 * idempotent with each other (plan §4A.7).
 */

import { useEffect, useRef } from "react";

import { sessionsApi } from "../api/sessions-api";
import { tasksApi, type Task } from "../api/tasks-api";
import { useSessionStore } from "../store/session-store";

export interface UseProjectListAutoRefreshOptions {
  /** Receives the FULL fresh task list for ``projectId`` on every successful
   *  tick (already filtered to this project). The consumer merges it in place
   *  (id-keyed) rather than replacing the array wholesale. */
  onTasks: (tasks: Task[]) => void;
  /** Poll cadence in ms; also the per-request timeout. Defaults to 4000. */
  intervalMs?: number;
}

export function useProjectListAutoRefresh(
  projectId: string,
  { onTasks, intervalMs = 4000 }: UseProjectListAutoRefreshOptions,
): void {
  const mergeProjectSessions = useSessionStore((s) => s.mergeProjectSessions);

  // Keep the latest ``onTasks`` without restarting the poller when its
  // identity changes between renders.
  const onTasksRef = useRef(onTasks);
  useEffect(() => {
    onTasksRef.current = onTasks;
  }, [onTasks]);

  useEffect(() => {
    if (!projectId) return;

    // Per-effect-instance state == one "generation". A ``projectId`` change
    // tears this down and starts a fresh effect, so late A responses are
    // dropped by ``stopped`` and aborted by ``controller.abort()``.
    let stopped = false;
    let inFlight = false;
    let currentController: AbortController | null = null;

    const runTick = async (): Promise<void> => {
      // Recurring-tick path pauses while the tab is hidden; the
      // visible/online catch-up calls ``runTick`` directly when it returns.
      if (typeof document !== "undefined" && document.hidden) return;
      // Single-flight: an overlapping tick is dropped, not queued.
      if (inFlight) return;
      inFlight = true;

      const controller = new AbortController();
      currentController = controller;
      // Bound a hung request to one interval so a stuck fetch can't block the
      // next recovery tick. The abort rejects the fetch → it lands in the
      // failed branch of ``allSettled`` below.
      const timeout = window.setTimeout(() => controller.abort(), intervalMs);

      try {
        const [sRes, tRes] = await Promise.allSettled([
          sessionsApi.list(projectId, { signal: controller.signal }),
          tasksApi.listTasks(projectId, { signal: controller.signal }),
        ]);
        // Drop a response that outlived this effect (unmount / id switch).
        if (stopped) return;
        if (sRes.status === "fulfilled") {
          // ``mergeProjectSessions`` itself enforces the project same-source
          // guard and the id-keyed subset merge.
          mergeProjectSessions(projectId, sRes.value.sessions);
        }
        if (tRes.status === "fulfilled") {
          // Belt-and-braces same-source assertion alongside the generation
          // guard: only hand the consumer rows that belong to this project.
          const tasks = tRes.value.tasks.filter(
            (task) => task.project_id === projectId,
          );
          onTasksRef.current(tasks);
        }
        // A rejected / aborted side is swallowed (plan §9.6): no toast, no
        // clear — that list keeps its last good value until a later tick
        // succeeds and backfills it.
      } finally {
        window.clearTimeout(timeout);
        if (currentController === controller) currentController = null;
        inFlight = false;
      }
    };

    // Immediate catch-up when the tab returns to the foreground or the network
    // comes back — both pass the single-flight gate inside ``runTick``.
    const onVisible = (): void => {
      if (typeof document === "undefined" || !document.hidden) void runTick();
    };
    const onOnline = (): void => {
      void runTick();
    };

    const intervalHandle = window.setInterval(() => void runTick(), intervalMs);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);

    return () => {
      stopped = true;
      window.clearInterval(intervalHandle);
      currentController?.abort();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [projectId, intervalMs, mergeProjectSessions]);
}
