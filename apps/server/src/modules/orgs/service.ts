/** Organizations: the tenant boundary. Members, their roles, and invites. */
import { createHash, randomBytes } from "node:crypto";
import type { Db, OrgRole } from "@agent-base/db";
import type { Auth } from "../../infra/context.ts";
import { badRequest, conflict, forbidden, notFound } from "../../infra/errors.ts";
import * as audit from "../audit/service.ts";
import * as sharing from "../sharing/service.ts";
import * as teams from "../teams/service.ts";
import * as repo from "./repo.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Create an organization owned by `userId`. Pass a transaction to make it part of a larger change. */
export async function create(db: Db, userId: string, name: string): Promise<{ id: string; name: string }> {
  const org = { id: crypto.randomUUID(), name, created_by: userId };
  await repo.insertOrgWithOwner(db, org);
  return { id: org.id, name };
}

export const listMemberships = repo.listMemberships;
export const listMembers = repo.listMembers;

export async function get(db: Db, auth: Auth) {
  const org = await repo.findOrg(db, auth.orgId);
  if (!org) throw notFound("organization");
  return { ...org, role: auth.role };
}

export async function rename(db: Db, auth: Auth, name: string) {
  await repo.renameOrg(db, auth.orgId, name);
  return { id: auth.orgId, name, role: auth.role };
}

/** An organization always keeps at least one owner. Call inside the transaction that changes the role. */
async function assertNotLastOwner(tx: Db, orgId: string, userId: string): Promise<void> {
  const owners = await repo.lockOwners(tx, orgId);
  if (owners.every((id) => id === userId)) throw conflict("an organization must keep at least one owner", "last_owner");
}

export async function changeRole(db: Db, auth: Auth, userId: string, role: OrgRole) {
  return db.transaction().execute(async (tx) => {
    const target = await repo.findMember(tx, auth.orgId, userId);
    if (!target) throw notFound("member");
    // Only an owner may make someone an owner, or take the role away.
    if ((role === "owner" || target.role === "owner") && auth.role !== "owner")
      throw forbidden("only an owner can change owner roles");
    if (target.role === "owner" && role !== "owner") await assertNotLastOwner(tx, auth.orgId, userId);
    await repo.setRole(tx, auth.orgId, userId, role);
    await audit.record(tx, auth, "member.role_change", { type: "user", id: userId }, { from: target.role, to: role });
    return { ...target, role };
  });
}

/** Remove a member (or leave). Everything granted to them in this organization ends with it. */
export async function removeMember(db: Db, auth: Auth, userId: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const target = await repo.findMember(tx, auth.orgId, userId);
    if (!target) throw notFound("member");
    if (target.role === "owner" && auth.role !== "owner") throw forbidden("only an owner can remove an owner");
    if (target.role === "owner") await assertNotLastOwner(tx, auth.orgId, userId);
    await repo.removeMember(tx, auth.orgId, userId);
    await sharing.revokeForPrincipal(tx, auth.orgId, "user", userId);
    await teams.removeUser(tx, auth.orgId, userId);
    await audit.record(tx, auth, userId === auth.userId ? "member.leave" : "member.remove", {
      type: "user",
      id: userId,
    });
  });
}

export async function invite(db: Db, auth: Auth, input: { email: string; role?: "admin" | "member" }) {
  const email = input.email.toLowerCase();
  if (await repo.findMemberByEmail(db, auth.orgId, email))
    throw conflict("that person is already a member", "already_member");
  const token = `inv_${randomBytes(32).toString("base64url")}`;
  const invite = await repo.insertInvite(db, {
    id: crypto.randomUUID(),
    org_id: auth.orgId,
    email,
    role: input.role ?? "member",
    token_hash: hashToken(token),
    invited_by: auth.userId,
    expires_at: new Date(Date.now() + INVITE_TTL_MS),
  });
  await audit.record(db, auth, "invite.create", { type: "invite", id: invite.id }, { email, role: invite.role });
  // The token is returned exactly once; only its hash is stored.
  return { ...invite, token };
}

export const listInvites = repo.listPendingInvites;

export async function revokeInvite(db: Db, auth: Auth, id: string): Promise<void> {
  if (!(await repo.deleteInvite(db, auth.orgId, id))) throw notFound("invite");
  await audit.record(db, auth, "invite.revoke", { type: "invite", id });
}

/**
 * Join the inviting organization. An invite is for one email address: holding
 * the token is not enough. Call inside a transaction.
 */
export async function acceptInvite(tx: Db, user: { id: string; email: string }, token: string): Promise<string> {
  const invite = await repo.lockUsableInvite(tx, hashToken(token));
  if (!invite) throw badRequest("this invite is invalid, expired, or already used", "invalid_invite");
  if (invite.email !== user.email.toLowerCase())
    throw forbidden("this invite was sent to a different email address", "invite_email_mismatch");
  await repo.addMember(tx, invite.org_id, user.id, invite.role);
  await repo.markInviteAccepted(tx, invite.id);
  await audit.record(tx, { userId: user.id, orgId: invite.org_id }, "member.join", { type: "user", id: user.id });
  return invite.org_id;
}
