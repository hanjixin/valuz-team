/**
 * Devices — desktops linked to the server as execution nodes. A device belongs
 * to the member who linked it and can be shared like any other resource;
 * `control` on it means remote control (its files, its shell, its sessions).
 */
import { createHash, randomBytes } from "node:crypto";
import { DEVICE_LINK_PATH, type RpcMethod, type RpcParams } from "@agent-base/protocol";
import type { Db } from "@agent-base/db";
import type { Auth, Ctx } from "../../infra/context.ts";
import { forbidden, notFound } from "../../infra/errors.ts";
import { orgChannel } from "../../infra/pubsub.ts";
import * as audit from "../audit/service.ts";
import * as sharing from "../sharing/service.ts";
import * as repo from "./repo.ts";

sharing.registerShareable("device", "devices");

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Wire this server's device hub to what a device's coming and going means. */
export function attach(ctx: Ctx): void {
  ctx.hub.listen({
    async hello(device, info) {
      await repo.recordHello(ctx.db, device.id, info);
      await ctx.pubsub.publish(orgChannel(device.orgId), { type: "device.online", device_id: device.id });
    },
    async closed(device) {
      await repo.touch(ctx.db, device.id);
      await ctx.pubsub.publish(orgChannel(device.orgId), { type: "device.offline", device_id: device.id });
    },
  });
}

/** The device a link token belongs to, unless it was revoked. */
export const authenticate = (db: Db, token: string) => repo.findByTokenHash(db, hashToken(token));

export async function register(ctx: Ctx, auth: Auth, name: string) {
  const id = crypto.randomUUID();
  const token = `dev_${randomBytes(32).toString("base64url")}`;
  await repo.insert(ctx.db, { id, org_id: auth.orgId, owner_id: auth.userId, name, token_hash: hashToken(token) });
  await audit.record(ctx.db, auth, "device.register", { type: "device", id }, { name });
  // The token is returned exactly once; only its hash is stored.
  return { id, name, token, owner_id: auth.userId, link_path: DEVICE_LINK_PATH };
}

export async function list(ctx: Ctx, auth: Auth) {
  const rows = await repo.list(ctx.db, auth);
  const online = await ctx.hub.online(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, online: online.has(row.id) }));
}

/** The device as the caller sees it. 404 unless they have some permission on it. */
export async function get(ctx: Ctx, auth: Auth, id: string, needed: sharing.Permission = "view") {
  const row = await repo.find(ctx.db, auth, id);
  if (!row?.permission) throw notFound("device");
  if (!sharing.permissionAtLeast(row.permission, needed))
    throw forbidden(`this needs "${needed}" permission on the device`);
  return { ...row, online: (await ctx.hub.online([id])).has(id) };
}

export async function rename(ctx: Ctx, auth: Auth, id: string, name: string) {
  const device = await get(ctx, auth, id, "admin");
  await repo.rename(ctx.db, id, name);
  return { ...device, name };
}

/** Its token stops working, its shares end, and its live link is dropped — on whichever replica holds it. */
async function revokeById(ctx: Ctx, auth: Auth, id: string, tx: Db = ctx.db): Promise<void> {
  await repo.revoke(tx, id);
  await sharing.revokeForResource(tx, "device", id);
  await audit.record(tx, auth, "device.revoke", { type: "device", id });
  await ctx.pubsub.publish(orgChannel(auth.orgId), { type: "device.revoked", device_id: id });
  await ctx.hub.drop(id);
}

export async function revoke(ctx: Ctx, auth: Auth, id: string): Promise<void> {
  await get(ctx, auth, id, "admin");
  await ctx.db.transaction().execute((tx) => revokeById(ctx, auth, id, tx));
}

/** A member left the organization: their machines stop being reachable by it. */
export async function revokeOwnedBy(ctx: Ctx, auth: Auth, ownerId: string, tx: Db): Promise<void> {
  for (const id of await repo.listOwnedBy(tx, auth.orgId, ownerId)) await revokeById(ctx, auth, id, tx);
}

/** Remote control: run one RPC on the device on behalf of the caller, and leave a trace of it. */
export async function remote<M extends RpcMethod>(
  ctx: Ctx,
  auth: Auth,
  id: string,
  method: M,
  params: RpcParams<M>,
): Promise<unknown> {
  await get(ctx, auth, id, "control");
  const logged: Record<string, unknown> = { ...params };
  // File contents do not belong in the audit trail; their size does.
  if (typeof logged["content"] === "string") logged["content"] = `<${logged["content"].length} chars>`;
  await audit.record(ctx.db, auth, `device.${method}`, { type: "device", id }, logged);
  const patience = 30_000 + (typeof logged["timeout_ms"] === "number" ? logged["timeout_ms"] : 0);
  return ctx.hub.call(id, method, params, { user_id: auth.userId, name: auth.name }, patience);
}
