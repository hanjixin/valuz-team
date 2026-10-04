/**
 * Time-bucket grouping for recency-sorted list rows — shared by the activity
 * overview and the project-detail tab lists so they read identically
 * (今天 / 昨天 / 本周 / 更早).
 */

export type TimeBucket = "today" | "yesterday" | "thisWeek" | "earlier";

export const bucketOf = (ms: number, now: Date): TimeBucket => {
  const d = new Date(ms);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startYesterday = new Date(startToday);
  startYesterday.setDate(startYesterday.getDate() - 1);
  const startWeek = new Date(startToday);
  startWeek.setDate(startWeek.getDate() - 7);
  if (d >= startToday) return "today";
  if (d >= startYesterday) return "yesterday";
  if (d >= startWeek) return "thisWeek";
  return "earlier";
};

export const BUCKET_ORDER: TimeBucket[] = [
  "today",
  "yesterday",
  "thisWeek",
  "earlier",
];

/** i18n keys for the bucket headers (already present in both locales). */
export const BUCKET_KEY: Record<TimeBucket, string> = {
  today: "activity.today",
  yesterday: "activity.yesterday",
  thisWeek: "activity.thisWeek",
  earlier: "activity.earlier",
};

/**
 * Group recency-sorted ``items`` into time buckets, preserving order within
 * each bucket. ``getMs`` extracts the timestamp the bucket is derived from.
 * Returns ``[bucket, items][]`` in ``BUCKET_ORDER``, omitting empty buckets.
 */
export function groupByTimeBucket<T>(
  items: T[],
  getMs: (item: T) => number,
): Array<[TimeBucket, T[]]> {
  const now = new Date();
  const groups = new Map<TimeBucket, T[]>();
  for (const item of items) {
    const b = bucketOf(getMs(item), now);
    const list = groups.get(b);
    if (list) list.push(item);
    else groups.set(b, [item]);
  }
  return BUCKET_ORDER.filter((b) => groups.has(b)).map((b) => [
    b,
    groups.get(b) ?? [],
  ]);
}
