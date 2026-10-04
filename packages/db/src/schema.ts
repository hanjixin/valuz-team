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
  user_settings: UserSettingsTable;
}
