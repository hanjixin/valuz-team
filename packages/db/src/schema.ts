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
  message_feedback: MessageFeedbackTable;
  user_settings: UserSettingsTable;
}
