import type { Migration } from "kysely";
import * as baseline from "./0001_baseline.ts";
import * as identity from "./0002_identity.ts";

/**
 * Every migration, keyed by name; Kysely applies them in key order. Listed
 * statically (not discovered on disk) so the bundled server carries them.
 * Each one must have a working `down`.
 */
export const migrations: Record<string, Migration> = {
  "0001_baseline": baseline,
  "0002_identity": identity,
};
