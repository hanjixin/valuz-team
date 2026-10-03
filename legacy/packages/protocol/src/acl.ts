/**
 * Collaboration model — organizations, roles, and the single share ladder used
 * for every shareable resource (agents, skills, connectors, providers,
 * projects, devices, sessions, files).
 */
import { z } from "zod";

export const OrgRole = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof OrgRole>;

export const ResourceType = z.enum([
  "agent",
  "skill",
  "connector",
  "provider",
  "project",
  "device",
  "session",
  "file",
]);
export type ResourceType = z.infer<typeof ResourceType>;

export const PrincipalType = z.enum(["org", "team", "user"]);
export type PrincipalType = z.infer<typeof PrincipalType>;

/**
 * One ordered ladder; each level implies the ones below it.
 *
 * - `view`    — see the resource (and watch a session / device status)
 * - `use`     — reference it: run an agent, equip a skill, call through a
 *               provider, start sessions on a device
 * - `edit`    — change its definition
 * - `control` — remote control: drive any session on a device, browse its
 *               shared folders, run commands on it; send to / interrupt a session
 * - `admin`   — re-share and delete (owners and org admins always have it)
 */
export const Permission = z.enum(["view", "use", "edit", "control", "admin"]);
export type Permission = z.infer<typeof Permission>;

const RANK: Record<Permission, number> = { view: 1, use: 2, edit: 3, control: 4, admin: 5 };

export const permissionRank = (p: Permission | null | undefined): number => (p ? RANK[p] : 0);

export const permissionAtLeast = (
  held: Permission | null | undefined,
  needed: Permission,
): boolean => permissionRank(held) >= RANK[needed];

export const maxPermission = (
  a: Permission | null | undefined,
  b: Permission | null | undefined,
): Permission | null => (permissionRank(a) >= permissionRank(b) ? (a ?? null) : (b ?? null));

export const ShareInput = z.object({
  principal_type: PrincipalType,
  /** Org id, team id, or user id. For `org` it defaults to the current org. */
  principal_id: z.string().optional(),
  permission: Permission.exclude(["admin"]),
});
export type ShareInput = z.infer<typeof ShareInput>;
