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
import * as skills from "./0010_skills.ts";
import * as connectors from "./0011_connectors.ts";
import * as tasks from "./0012_tasks.ts";
import * as attachments from "./0013_attachments.ts";
import * as knowledge from "./0014_knowledge.ts";
import * as memory from "./0015_memory.ts";
import * as automations from "./0016_automations.ts";
import * as kbAttachments from "./0017_kb_attachments.ts";
import * as channels from "./0018_channels.ts";
import * as artifacts from "./0019_artifacts.ts";
import * as channelDevice from "./0020_channel_device.ts";
import * as builtinAgent from "./0021_builtin_agent.ts";
import * as memorySnapshots from "./0022_memory_snapshots.ts";
import * as channelChatBindings from "./0023_channel_chat_bindings.ts";
import * as connectorOauth from "./0024_connector_oauth.ts";

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
  "0010_skills": skills,
  "0011_connectors": connectors,
  "0012_tasks": tasks,
  "0013_attachments": attachments,
  "0014_knowledge": knowledge,
  "0015_memory": memory,
  "0016_automations": automations,
  "0017_kb_attachments": kbAttachments,
  "0018_channels": channels,
  "0019_artifacts": artifacts,
  "0020_channel_device": channelDevice,
  "0021_builtin_agent": builtinAgent,
  "0022_memory_snapshots": memorySnapshots,
  "0023_channel_chat_bindings": channelChatBindings,
  "0024_connector_oauth": connectorOauth,
};
