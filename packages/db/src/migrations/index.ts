import type { Migration } from "kysely";
import * as baseline from "./0001_baseline.ts";
import * as identity from "./0002_identity.ts";
import * as collaboration from "./0003_collaboration.ts";
import * as devices from "./0004_devices.ts";
import * as providers from "./0005_providers.ts";
import * as agents from "./0006_agents.ts";
import * as projects from "./0007_projects.ts";
import * as sessions from "./0008_sessions.ts";
import * as notificationsFeedback from "./0009_notifications_feedback.ts";

/**
 * Every migration, keyed by name; Kysely applies them in key order. Listed
 * statically (not discovered on disk) so the bundled server carries them.
 * Each one must have a working `down`.
 */
export const migrations: Record<string, Migration> = {
  "0001_baseline": baseline,
  "0002_identity": identity,
  "0003_collaboration": collaboration,
  "0004_devices": devices,
  "0005_providers": providers,
  "0006_agents": agents,
  "0007_projects": projects,
  "0008_sessions": sessions,
  "0009_notifications_feedback": notificationsFeedback,
};
