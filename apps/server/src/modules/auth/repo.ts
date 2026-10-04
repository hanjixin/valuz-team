import type { Db } from "@agent-base/db";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
}

export const findUserByEmail = (db: Db, email: string): Promise<UserRow | undefined> =>
  db.selectFrom("users").select(["id", "email", "name", "password_hash"]).where("email", "=", email).executeTakeFirst();

export const findUserById = (db: Db, id: string) =>
  db.selectFrom("users").select(["id", "email", "name"]).where("id", "=", id).executeTakeFirst();

export const insertUser = async (db: Db, user: UserRow): Promise<void> =>
  void (await db.insertInto("users").values(user).execute());
