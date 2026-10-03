/**
 * Persistent strip shown above the Composer while the agent has one or more
 * background tasks (``run_in_background`` shell commands) still running.
 *
 * The turn that LAUNCHED a background task ends normally — the agent replies
 * "started" and the conversation goes idle while the process keeps running
 * for minutes. Without this strip the conversation reads as "finished" and
 * the user has no cue that work is still in flight (the completion later
 * arrives on its own via the CLI wake-up turn). State is derived from the
 * persisted ``session.bg_task.*`` events, so the strip also survives
 * re-entering the page mid-run.
 */
import { memo } from "react";

import { useI18n } from "../../hooks/use-i18n";
import { StatusPill } from "../common/StatusPill";

export interface BackgroundTaskStripItem {
  taskId: string;
  description: string;
}

interface BackgroundTaskStripProps {
  /** Tasks currently in ``running`` state; the strip hides when empty. */
  tasks: BackgroundTaskStripItem[];
}

export const BackgroundTaskStrip = memo(function BackgroundTaskStrip({
  tasks,
}: BackgroundTaskStripProps) {
  const { t } = useI18n();
  if (tasks.length === 0) return null;
  return (
    <div
      data-slot="background-task-strip"
      className="mx-auto mb-2 flex w-full max-w-[760px] items-center gap-2 rounded-lg border border-surface-border bg-surface-soft px-3 py-2 text-xs text-ink-muted"
    >
      <StatusPill
        status="running"
        label={t("conversation.bgTask.running", { count: tasks.length })}
      />
      <span className="min-w-0 truncate">
        {tasks.map((task) => task.description).join(" · ")}
      </span>
    </div>
  );
});
