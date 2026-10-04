/**
 * Client for agent-base's collaboration endpoints: the organization, its
 * members and teams, devices, and who a resource is shared with.
 * (agent-base addition — see UPSTREAM.md.)
 */
import { requestJson } from "./request";

export type OrgRole = "owner" | "admin" | "member";
export type SharePermission = "view" | "use" | "edit" | "control";
export type Permission = SharePermission | "admin";
export type ShareableType =
  "agent" | "skill" | "connector" | "provider" | "project" | "device" | "session" | "file";
export type PrincipalType = "org" | "team" | "user";

export interface Org {
  id: string;
  name: string;
  role: OrgRole;
}
export interface OrgMember {
  id: string;
  email: string;
  name: string;
  role: OrgRole;
  joined_at: string;
}
export interface OrgInvite {
  id: string;
  email: string;
  role: "admin" | "member";
  expires_at: string;
  created_at: string;
  /** Present only in the response that created the invite. */
  token?: string;
}
export interface Team {
  id: string;
  name: string;
  member_ids: string[];
}
export interface DeviceInfo {
  hostname?: string;
  platform?: string;
  arch?: string;
  host_version?: string;
  runtimes?: { runtime: string; available: boolean; detail?: string }[];
  shared_roots?: string[];
  allow_exec?: boolean;
}
export interface Device {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  info: DeviceInfo;
  online: boolean;
  permission: Permission;
  last_seen_at: string | null;
  created_at: string;
}
export interface Share {
  id: string;
  principal_type: PrincipalType;
  principal_id: string;
  principal_name: string | null;
  permission: SharePermission;
}
export interface DeviceFsEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  size?: number;
}

const send = <T>(method: string, path: string, json?: unknown): Promise<T> =>
  requestJson<T>(path, { method, ...(json === undefined ? {} : { json }) });

export const teamApi = {
  org: () => send<Org>("GET", "/v1/org"),
  renameOrg: (name: string) => send<Org>("PATCH", "/v1/org", { name }),

  members: () => send<{ members: OrgMember[] }>("GET", "/v1/org/members").then((r) => r.members),
  setRole: (userId: string, role: OrgRole) =>
    send<OrgMember>("PATCH", `/v1/org/members/${userId}`, { role }),
  removeMember: (userId: string) => send<void>("DELETE", `/v1/org/members/${userId}`),

  invites: () => send<{ invites: OrgInvite[] }>("GET", "/v1/org/invites").then((r) => r.invites),
  invite: (email: string, role: "admin" | "member") =>
    send<OrgInvite>("POST", "/v1/org/invites", { email, role }),
  revokeInvite: (id: string) => send<void>("DELETE", `/v1/org/invites/${id}`),

  teams: () => send<{ teams: Team[] }>("GET", "/v1/org/teams").then((r) => r.teams),
  createTeam: (name: string) => send<Team>("POST", "/v1/org/teams", { name }),
  setTeamMembers: (id: string, userIds: string[]) =>
    send<Team>("PUT", `/v1/org/teams/${id}/members`, { user_ids: userIds }),
  deleteTeam: (id: string) => send<void>("DELETE", `/v1/org/teams/${id}`),

  devices: () => send<{ devices: Device[] }>("GET", "/v1/devices").then((r) => r.devices),
  renameDevice: (id: string, name: string) => send<Device>("PATCH", `/v1/devices/${id}`, { name }),
  revokeDevice: (id: string) => send<void>("DELETE", `/v1/devices/${id}`),
  listDeviceFolder: (id: string, path: string) =>
    send<{ path: string; entries: DeviceFsEntry[] }>("POST", `/v1/devices/${id}/fs/list`, { path }),

  shares: (type: ShareableType, id: string) =>
    send<{ shares: Share[] }>("GET", `/v1/shares/${type}/${id}`).then((r) => r.shares),
  share: (
    type: ShareableType,
    id: string,
    grant: { principal_type: PrincipalType; principal_id?: string; permission: SharePermission },
  ) => send<Share>("PUT", `/v1/shares/${type}/${id}`, grant),
  unshare: (type: ShareableType, id: string, shareId: string) =>
    send<void>("DELETE", `/v1/shares/${type}/${id}/${shareId}`),
};
