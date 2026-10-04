/** Per-member settings, kept apart for each organization the member is in. */
import type { Schema } from "@agent-base/contract";
import type { Db } from "@agent-base/db";
import * as repo from "./repo.ts";

type Preferences = Schema<"PreferencesResponse">;
type Stored = Omit<Preferences, "detected_timezone">;

const DEFAULTS: Stored = {
  default_timezone: "UTC",
  default_locale: "zh-CN",
  theme: "light",
  font_size: "default",
  conversation_citations_enabled: true,
  conversation_verification_enabled: false,
  conversation_task_coverage_enabled: true,
  ptc_enabled: false,
};

/** A typed slot in a member's settings; other modules keep their own settings through it. */
export async function get<T extends object>(db: Db, scope: repo.Scope, key: string, defaults: T): Promise<T> {
  return { ...defaults, ...((await repo.read(db, scope, key)) as Partial<T> | undefined) };
}

export const set = repo.write;

const present = (stored: Stored): Preferences => ({
  ...stored,
  detected_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

export const getPreferences = async (db: Db, scope: repo.Scope): Promise<Preferences> =>
  present(await get(db, scope, "preferences", DEFAULTS));

export async function patchPreferences(
  db: Db,
  scope: repo.Scope,
  patch: Schema<"PreferencesPatch">,
): Promise<Preferences> {
  const next: Stored = { ...(await get(db, scope, "preferences", DEFAULTS)) };
  for (const [key, value] of Object.entries(patch) as [keyof Stored, Stored[keyof Stored] | null | undefined][]) {
    if (value === undefined) continue;
    // null resets a field to its default.
    Object.assign(next, { [key]: value ?? DEFAULTS[key] });
  }
  // Verification is a check on citations: it cannot stay on without them.
  if (!next.conversation_citations_enabled) next.conversation_verification_enabled = false;
  await set(db, scope, "preferences", next);
  return present(next);
}
