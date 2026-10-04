/** Teams: named groups of members that a resource can be shared with. */
import type { Db } from "@agent-base/db";
import type { Auth } from "../../infra/context.ts";
import { badRequest, conflict, notFound } from "../../infra/errors.ts";
import * as sharing from "../sharing/service.ts";
import * as repo from "./repo.ts";

export const list = repo.list;

async function assertNameFree(db: Db, orgId: string, name: string, except?: string): Promise<void> {
  const existing = await repo.findByName(db, orgId, name);
  if (existing && existing.id !== except) throw conflict("a team with this name already exists", "team_name_taken");
}

export async function create(db: Db, auth: Auth, name: string) {
  await assertNameFree(db, auth.orgId, name);
  const id = crypto.randomUUID();
  await repo.insert(db, { id, org_id: auth.orgId, name });
  return { id, name, member_ids: [] as string[] };
}

async function mustFind(db: Db, orgId: string, id: string) {
  const team = await repo.find(db, orgId, id);
  if (!team) throw notFound("team");
  return team;
}

export async function rename(db: Db, auth: Auth, id: string, name: string) {
  const team = await mustFind(db, auth.orgId, id);
  await assertNameFree(db, auth.orgId, name, id);
  await repo.rename(db, auth.orgId, id, name);
  return { ...team, name };
}

export async function setMembers(db: Db, auth: Auth, id: string, userIds: string[]) {
  const team = await mustFind(db, auth.orgId, id);
  const unique = [...new Set(userIds)].sort();
  if ((await repo.countOrgMembers(db, auth.orgId, unique)) !== unique.length)
    throw badRequest("every team member must belong to the organization");
  await db.transaction().execute((tx) => repo.replaceMembers(tx, id, unique));
  return { ...team, member_ids: unique };
}

/** Deleting a team ends every share granted to it. */
export async function remove(db: Db, auth: Auth, id: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    if (!(await repo.remove(tx, auth.orgId, id))) throw notFound("team");
    await sharing.revokeForPrincipal(tx, auth.orgId, "team", id);
  });
}

/** A member left the organization: take them out of its teams. */
export const removeUser = repo.removeUser;
