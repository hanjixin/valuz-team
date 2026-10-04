/**
 * Database schema types. Hand-maintained alongside the migrations until the
 * schema settles; `kysely-codegen` can regenerate it from a live database.
 */
import type { ColumnType } from "kysely";

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

export interface Database {
  app_meta: AppMetaTable;
  users: UsersTable;
  orgs: OrgsTable;
  org_members: OrgMembersTable;
}
