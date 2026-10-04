import type { useTranslation } from "@valuz/core";

// Relative "created N ago" for list rows' trailing meta — same i18n buckets as
// the activity timeline. A session's list ``updated_at`` is its creation time
// (the kernel session carries only ``created_at``, which the host mapper copies
// into ``updated_at``).
//
// Lives in its own module (not alongside ``RowActionsMenu``) so the component
// file only ever exports components — a mixed component + runtime-value export
// breaks Vite React Fast Refresh and leaves this binding ``undefined`` after an
// HMR update.
export const formatCreatedAt = (
  ms: number,
  t: ReturnType<typeof useTranslation>["t"],
): string => {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return t("time.justNow" as Parameters<typeof t>[0]);
  if (min < 60)
    return t("time.minutesAgo" as Parameters<typeof t>[0], { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("time.hoursAgo" as Parameters<typeof t>[0], { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t("time.daysAgo" as Parameters<typeof t>[0], { count: day });
  return new Date(ms).toLocaleDateString();
};
