import type { WorktreeListResponse } from "@valuz/shared";

import { createFetchJson } from "./fetch-json";
import { resolveApiBase } from "./base-resolver";

let _apiBase =
  (import.meta as unknown as Record<string, Record<string, string> | undefined>)
    .env?.VITE_API_BASE_URL || "http://localhost:8000";

export const setWorktreesApiBase = (url: string): void => {
  _apiBase = url;
};

const fetchJson = createFetchJson(() => _apiBase);
const projectBase = (projectId: string): string =>
  resolveApiBase({ projectId }, _apiBase);

/**
 * Project worktrees — `/v1/projects/{id}/worktrees`. Git is the source of
 * truth: the list (and its dirty/ahead counts) is computed on read, and the
 * response carries the project's `ProjectGitInfo` so callers can gate the
 * "run in worktree" toggle with the same single fetch.
 */
export const worktreesApi = {
  list(projectId: string): Promise<WorktreeListResponse> {
    return fetchJson(
      `/v1/projects/${encodeURIComponent(projectId)}/worktrees`,
      { baseUrl: projectBase(projectId) },
    );
  },

  /**
   * Discard a worktree. Fail-closed on the backend: a worktree with
   * uncommitted files / unmerged commits (or unverifiable state) returns
   * 409 unless `force` is set — show the dirty/ahead counts in a confirm
   * dialog first, then retry with `force: true`.
   */
  discard(
    projectId: string,
    name: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    const qs = opts?.force ? "?force=true" : "";
    return fetchJson(
      `/v1/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(name)}${qs}`,
      { method: "DELETE", baseUrl: projectBase(projectId) },
    );
  },
};
