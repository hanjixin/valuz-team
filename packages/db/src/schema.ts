/**
 * Database schema types. Hand-maintained alongside the migrations until the
 * schema settles; `kysely-codegen` can regenerate it from a live database.
 */
import type { ColumnType, Generated } from "kysely";

export interface AppMetaTable {
  key: string;
  value: ColumnType<unknown, string, string>;
  updated_at: ColumnType<Date, Date | undefined, Date | undefined>;
}

type Timestamp = ColumnType<Date, Date | undefined, Date | undefined>;

export type OrgRole = "owner" | "admin" | "member";

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: Timestamp;
}

export interface OrgsTable {
  id: string;
  name: string;
  created_by: string;
  created_at: Timestamp;
}

export interface OrgMembersTable {
  org_id: string;
  user_id: string;
  role: OrgRole;
  joined_at: Timestamp;
}

export interface OrgInvitesTable {
  id: string;
  org_id: string;
  email: string;
  role: Exclude<OrgRole, "owner">;
  token_hash: string;
  invited_by: string;
  expires_at: ColumnType<Date, Date, Date>;
  accepted_at: ColumnType<Date | null, Date | undefined, Date | null>;
  created_at: Timestamp;
}

export interface TeamsTable {
  id: string;
  org_id: string;
  name: string;
  created_at: Timestamp;
}

export interface TeamMembersTable {
  team_id: string;
  user_id: string;
}

export type PrincipalType = "org" | "team" | "user";
/** What a share can grant, weakest first. `admin` is held by owners and org admins, never granted. */
export type SharePermission = "view" | "use" | "edit" | "control";

export interface ResourceSharesTable {
  id: string;
  org_id: string;
  resource_type: string;
  resource_id: string;
  principal_type: PrincipalType;
  principal_id: string;
  permission: SharePermission;
  rank: number;
  created_by: string;
  created_at: Timestamp;
}

export interface AuditLogsTable {
  id: Generated<number>;
  org_id: string;
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  detail: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Timestamp;
}

export interface DevicesTable {
  id: string;
  org_id: string;
  owner_id: string;
  name: string;
  token_hash: string;
  /** What the host reported about itself on its last hello. */
  info: ColumnType<Record<string, unknown>, string | undefined, string>;
  last_seen_at: ColumnType<Date | null, Date | undefined, Date | null>;
  revoked_at: ColumnType<Date | null, Date | undefined, Date | null>;
  created_at: Timestamp;
}

export interface StoredModel {
  id: string;
  label?: string;
  /** The model's input window in tokens, where the channel's owner declared it. */
  max_input_tokens?: number;
}

export interface ProvidersTable {
  id: string;
  org_id: string;
  owner_id: string;
  name: string;
  provider_kind: string;
  protocol: string | null;
  base_url: string | null;
  default_model: string | null;
  models: ColumnType<StoredModel[], string | undefined, string>;
  secret_enc: string | null;
  test_status: ColumnType<string, string | undefined, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UserSettingsTable {
  org_id: string;
  user_id: string;
  key: string;
  value: ColumnType<unknown, string, string>;
  updated_at: Timestamp;
}

type JsonList = ColumnType<string[], string | undefined, string>;

export interface AgentsTable {
  id: string;
  org_id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  instructions: ColumnType<string, string | undefined, string>;
  runtime: string;
  model: string;
  provider_id: string | null;
  effort: string | null;
  skills: JsonList;
  connector_types: JsonList;
  knowledge_scope: JsonList;
  inherit_global_instructions: ColumnType<boolean, boolean | undefined, boolean>;
  permission_mode: ColumnType<string, string | undefined, string>;
  avatar: string | null;
  /** "system" for a member's built-in assistant. */
  kind: ColumnType<string, string | undefined, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProjectsTable {
  id: string;
  org_id: string;
  owner_id: string;
  name: string;
  kind: ColumnType<"chat" | "project", "chat" | "project" | undefined, "chat" | "project">;
  icon: string | null;
  instructions_md: ColumnType<string, string | undefined, string>;
  default_lead_agent_slug: string | null;
  device_id: string | null;
  root_path: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProjectMembersTable {
  id: string;
  project_id: string;
  agent_id: string;
  agent_slug: string;
  created_at: Timestamp;
}

type Json<T> = ColumnType<T, string | null | undefined, string | null>;

export interface SessionsTable {
  id: string;
  org_id: string;
  owner_id: string;
  project_id: string;
  device_id: string | null;
  agent_id: string | null;
  agent_slug: string | null;
  provider_id: string | null;
  name: string | null;
  runtime_provider: string;
  model: ColumnType<string, string | undefined, string>;
  cwd: string;
  effort: string | null;
  permission_mode: ColumnType<string, string | undefined, string>;
  mode: ColumnType<string, string | undefined, string>;
  status: ColumnType<string, string | undefined, string>;
  origin: ColumnType<string, string | undefined, string>;
  stop_reason: Json<Record<string, unknown> | null>;
  runtime_session_id: string | null;
  todos: Json<Record<string, unknown>[] | null>;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  last_user_message_text: string | null;
  queue_paused: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MessagesTable {
  id: string;
  session_id: string;
  actor_id: string | null;
  user_message: ColumnType<Record<string, unknown>, string, string>;
  status: ColumnType<string, string | undefined, string>;
  assistant_message: string | null;
  error_message: Json<Record<string, unknown> | null>;
  stop_reason: Json<Record<string, unknown> | null>;
  total_turns: ColumnType<number, number | undefined, number>;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  model_usage: Json<Record<string, unknown> | null>;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  todos: Json<Record<string, unknown>[] | null>;
  started_at: number;
  ended_at: number | null;
}

export interface EventsTable {
  seq: Generated<number>;
  session_id: string;
  message_id: string;
  type: string;
  data: ColumnType<Record<string, unknown>, string, string>;
  ts: number;
  event_uid: string;
}

export interface QueuedInputsTable {
  id: string;
  session_id: string;
  actor_id: string;
  text: string;
  position: Generated<number>;
  created_at: Timestamp;
  updated_at: ColumnType<Date | null, Date | undefined, Date | null>;
}

type NullableTime = ColumnType<Date | null, Date | undefined, Date | null>;

export interface NotificationsTable {
  id: string;
  org_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: ColumnType<string, string | undefined, string>;
  route: string | null;
  action: ColumnType<string, string | undefined, string>;
  urgency: ColumnType<string, string | undefined, string>;
  project_id: string | null;
  session_id: string | null;
  payload: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Timestamp;
  read_at: NullableTime;
  resolved_at: NullableTime;
}

export interface MessageFeedbackTable {
  id: string;
  session_id: string;
  message_id: string;
  user_id: string;
  action: string;
  block_ref: ColumnType<string, string | undefined, string>;
  value: string | null;
  reason_code: string | null;
  reason: string | null;
  source: ColumnType<string, string | undefined, string>;
  surface: string | null;
  occurrences: ColumnType<number, number | undefined, number>;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillsTable {
  id: string;
  org_id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  files: ColumnType<SkillFile[], string, string>;
  version: ColumnType<number, number | undefined, number>;
  creation_origin: ColumnType<string, string | undefined, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SkillVersionsTable {
  id: string;
  skill_id: string;
  version: number;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  files: ColumnType<SkillFile[], string, string>;
  created_by: string | null;
  created_at: Timestamp;
}

/** One header, query parameter or environment variable of a connector. A secret one carries no value here. */
export interface ConnectorEntry {
  key: string;
  secret: boolean;
  value: string | null;
}

export interface ConnectorConfig {
  url: string | null;
  command: string | null;
  args: string[];
  working_dir: string | null;
  headers: ConnectorEntry[];
  params: ConnectorEntry[];
  env: ConnectorEntry[];
}

export interface ConnectorsTable {
  id: string;
  org_id: string;
  owner_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  transport: string;
  auth_type: ColumnType<string, string | undefined, string>;
  config: ColumnType<ConnectorConfig, string, string>;
  secret_enc: string | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  status: ColumnType<string, string | undefined, string>;
  tool_count: number | null;
  last_tested_at: NullableTime;
  error_message: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TasksTable {
  id: string;
  org_id: string;
  owner_id: string;
  project_id: string;
  device_id: string | null;
  title: string;
  goal: string;
  status: string;
  lead_agent_slug: string;
  lead_session_id: string | null;
  cwd: string;
  plan: ColumnType<{ subtasks: unknown[] }, string | undefined, string>;
  plan_version: ColumnType<number, number | undefined, number>;
  result: Json<Record<string, unknown> | null>;
  idle_nudges: ColumnType<number, number | undefined, number>;
  committed_at: NullableTime;
  ended_at: NullableTime;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaskRunsTable {
  id: string;
  task_id: string;
  session_id: string;
  agent_slug: string;
  kind: "lead" | "subtask";
  subtask_key: string | null;
  status: ColumnType<string, string | undefined, string>;
  sequence: Generated<number>;
  created_at: Timestamp;
  ended_at: NullableTime;
}

export interface TaskEventsTable {
  seq: Generated<number>;
  task_id: string;
  type: string;
  actor: string;
  session_id: string | null;
  payload: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Timestamp;
}

export interface TaskMailboxTable {
  id: Generated<number>;
  task_id: string;
  session_id: string;
  kind: string;
  text: ColumnType<string, string | undefined, string>;
  payload: ColumnType<Record<string, unknown>, string | undefined, string>;
  consumed_at: NullableTime;
  created_at: Timestamp;
}

export interface AttachmentsTable {
  id: string;
  org_id: string;
  owner_id: string;
  session_id: string | null;
  file_name: string;
  size_bytes: number;
  mime_type: string | null;
  /** Where an upload waits in storage; null for a reference to a knowledge-base document. */
  storage_key: string | null;
  kb_document_id: ColumnType<string | null, string | null | undefined, string | null>;
  device_path: string | null;
  created_at: Timestamp;
  consumed_at: NullableTime;
}

export interface KnowledgeBasesTable {
  id: string;
  org_id: string;
  owner_id: string;
  name: string;
  created_at: Timestamp;
}

export interface KbDocumentsTable {
  id: string;
  org_id: string;
  kb_id: string;
  owner_id: string;
  relative_path: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  storage_key: string;
  status: ColumnType<"queued" | "processing" | "ready" | "failed", string | undefined, string>;
  error: string | null;
  content: ColumnType<string, string | undefined, string>;
  chunk_count: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface KbChunksTable {
  id: Generated<number>;
  document_id: string;
  ord: number;
  content: string;
}

export interface KbTasksTable {
  id: string;
  org_id: string;
  kb_id: string | null;
  task_type: string;
  total_items: number;
  processed_items: ColumnType<number, number | undefined, number>;
  failed_items: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
}

export interface ProjectKbBindingsTable {
  project_id: string;
  binding_kind: "kb" | "folder" | "document";
  target_id: string;
}

export interface MemoriesTable {
  id: string;
  org_id: string;
  target: "user" | "global" | "project";
  user_id: string | null;
  project_id: string | null;
  content: string;
  source: string;
  created_at: Timestamp;
}

export interface MemoryReviewsTable {
  session_id: string;
  reviewed_until: number;
}

export interface ArtifactsTable {
  id: string;
  org_id: string;
  project_id: string;
  device_id: string | null;
  file_path: string;
  display_name: string;
  version_no: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ArtifactRevisionsTable {
  id: string;
  artifact_id: string;
  version_no: number;
  session_id: string | null;
  file_size: number;
  mime_type: string | null;
  created_at: Timestamp;
}

export interface ChannelBindingsTable {
  id: string;
  org_id: string;
  owner_id: string;
  platform: string;
  agent_slug: string;
  app_id: string;
  secret_enc: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** The device holding the bot's connection to its platform. */
  device_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChannelThreadsTable {
  binding_id: string;
  external_chat_id: string;
  session_id: string;
}

export interface AutomationTrigger {
  kind: "cron" | "interval" | "manual";
  cron_expr?: string;
  timezone?: string | null;
  seconds?: number;
}

export interface AutomationsTable {
  id: string;
  org_id: string;
  owner_id: string;
  project_id: string;
  name: string;
  agent_kind: string | null;
  agent_slug: string | null;
  action_kind: "chat" | "task";
  prompt_template: string;
  trigger: ColumnType<AutomationTrigger, string, string>;
  status: ColumnType<"enabled" | "paused", "enabled" | "paused" | undefined, "enabled" | "paused">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AutomationRunsTable {
  id: string;
  automation_id: string;
  trigger_type: string;
  status: string;
  input: ColumnType<unknown, string | null | undefined, string | null>;
  result_summary: string | null;
  error_code: string | null;
  error_message: string | null;
  session_id: string | null;
  task_id: string | null;
  triggered_at: Timestamp;
  started_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  completed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  cancel_requested_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface Database {
  app_meta: AppMetaTable;
  users: UsersTable;
  orgs: OrgsTable;
  org_members: OrgMembersTable;
  org_invites: OrgInvitesTable;
  teams: TeamsTable;
  team_members: TeamMembersTable;
  resource_shares: ResourceSharesTable;
  audit_logs: AuditLogsTable;
  devices: DevicesTable;
  providers: ProvidersTable;
  agents: AgentsTable;
  projects: ProjectsTable;
  project_members: ProjectMembersTable;
  sessions: SessionsTable;
  messages: MessagesTable;
  events: EventsTable;
  queued_inputs: QueuedInputsTable;
  notifications: NotificationsTable;
  skills: SkillsTable;
  skill_versions: SkillVersionsTable;
  connectors: ConnectorsTable;
  tasks: TasksTable;
  task_runs: TaskRunsTable;
  task_events: TaskEventsTable;
  task_mailbox: TaskMailboxTable;
  attachments: AttachmentsTable;
  knowledge_bases: KnowledgeBasesTable;
  kb_documents: KbDocumentsTable;
  kb_chunks: KbChunksTable;
  kb_tasks: KbTasksTable;
  project_kb_bindings: ProjectKbBindingsTable;
  artifacts: ArtifactsTable;
  artifact_revisions: ArtifactRevisionsTable;
  channel_bindings: ChannelBindingsTable;
  channel_threads: ChannelThreadsTable;
  automations: AutomationsTable;
  automation_runs: AutomationRunsTable;
  memories: MemoriesTable;
  memory_reviews: MemoryReviewsTable;
  message_feedback: MessageFeedbackTable;
  user_settings: UserSettingsTable;
}
