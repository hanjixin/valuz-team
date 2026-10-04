/**
 * Project worktree types — mirror `api/openapi.yaml` (WorktreeRef /
 * ProjectGitInfo / WorktreeItem / WorktreeListResponse). Git is the source
 * of truth: list/status fields are computed on read by the backend, never
 * persisted. See docs/design/project-worktree-design.md.
 */

/**
 * Immutable pointer to the worktree a session was created in (read from the
 * session's creation-time metadata snapshot). `null` on a session means it
 * runs in the project's main workspace.
 */
export interface WorktreeRef {
  name: string;
  branch: string | null;
  path: string;
  /**
   * Liveness computed on read — populated on session *detail* fetches only
   * (`null`/undefined on list items). `false` means the worktree was removed
   * since the session was created; the next send self-heals by recreating it
   * at the same path (fresh branch off the repo's current HEAD).
   */
  exists?: boolean | null;
}

/**
 * Computed-on-read git facts for a project's resolved cwd — the feature gate
 * for worktree UI (the "run in worktree" toggle only shows when
 * `git_available && is_repo`).
 */
export interface ProjectGitInfo {
  git_available: boolean;
  is_repo: boolean;
  git_root?: string | null;
  /**
   * Relative path of the project cwd inside the repo when the bound folder
   * is a subdirectory of it ("" when they coincide).
   */
  subdir?: string | null;
}

/** One row of the project's Worktrees panel. */
export interface WorktreeItem {
  name: string;
  branch: string | null;
  path: string;
  /**
   * Who created it — "u" (user-initiated session) worktrees are never
   * auto-swept; "task" worktrees are eligible for the stale sweep.
   */
  origin: "u" | "task" | string;
  /**
   * Change-detection anchor (commit the worktree was created from). `null`
   * when the sidecar metadata was lost — status can't be verified and
   * discard requires `force`.
   */
  base_sha: string | null;
  /** Unix epoch milliseconds (UTC). */
  created_at: number | null;
  /** Uncommitted-file count; `null` = could not verify (render "unknown"). */
  dirty_files: number | null;
  /** Commits past `base_sha`; `null` = could not verify. */
  ahead_commits: number | null;
}

export interface WorktreeListResponse {
  git: ProjectGitInfo;
  worktrees: WorktreeItem[];
}
