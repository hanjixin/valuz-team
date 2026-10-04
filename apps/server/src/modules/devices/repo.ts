import type { Db } from "@agent-base/db";
import { sql } from "kysely";
import type { Auth } from "../../infra/context.ts";
import { permissionOf } from "../sharing/service.ts";

/** Devices the caller has any permission on, each labelled with that permission. */
const visible = (db: Db, auth: Auth) =>
  db
    .selectFrom("devices as r")
    .innerJoin("users as u", "u.id", "r.owner_id")
    .select(["r.id", "r.name", "r.owner_id", "u.name as owner_name", "r.info", "r.last_seen_at", "r.created_at"])
    .select(permissionOf(auth, "device", "r").as("permission"))
    .where("r.org_id", "=", auth.orgId)
    .where("r.revoked_at", "is", null)
    .where(sql<boolean>`${permissionOf(auth, "device", "r")} IS NOT NULL`);

export const list = (db: Db, auth: Auth) => visible(db, auth).orderBy("r.created_at", "desc").execute();

export const find = (db: Db, auth: Auth, id: string) => visible(db, auth).where("r.id", "=", id).executeTakeFirst();

export const insert = async (
  db: Db,
  device: { id: string; org_id: string; owner_id: string; name: string; token_hash: string },
): Promise<void> => void (await db.insertInto("devices").values(device).execute());

export const rename = async (db: Db, id: string, name: string): Promise<void> =>
  void (await db.updateTable("devices").set({ name }).where("id", "=", id).execute());

export const revoke = async (db: Db, id: string): Promise<void> =>
  void (await db.updateTable("devices").set({ revoked_at: new Date() }).where("id", "=", id).execute());

export const listOwnedBy = async (db: Db, orgId: string, ownerId: string): Promise<string[]> =>
  (
    await db
      .selectFrom("devices")
      .select("id")
      .where("org_id", "=", orgId)
      .where("owner_id", "=", ownerId)
      .where("revoked_at", "is", null)
      .execute()
  ).map((row) => row.id);

export const findByTokenHash = (db: Db, tokenHash: string) =>
  db
    .selectFrom("devices")
    .select(["id", "org_id"])
    .where("token_hash", "=", tokenHash)
    .where("revoked_at", "is", null)
    .executeTakeFirst();

export const recordHello = async (db: Db, id: string, info: Record<string, unknown>): Promise<void> =>
  void (await db
    .updateTable("devices")
    .set({ info: JSON.stringify(info), last_seen_at: new Date() })
    .where("id", "=", id)
    .execute());

export const touch = async (db: Db, id: string): Promise<void> =>
  void (await db.updateTable("devices").set({ last_seen_at: new Date() }).where("id", "=", id).execute());
