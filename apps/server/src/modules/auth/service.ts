import { createHash, randomBytes } from "node:crypto";
import type { Schema } from "@agent-base/contract";
import { hash, verify } from "@node-rs/argon2";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../../infra/context.ts";
import { conflict, forbidden, unauthorized } from "../../infra/errors.ts";
import * as repo from "./repo.ts";

const refreshKey = (token: string): string => `rt:${createHash("sha256").update(token).digest("hex")}`;

/** A short-lived signed access token plus an opaque, single-use refresh token (stored only as a hash). */
export async function issueTokens(app: FastifyInstance, userId: string): Promise<Schema<"AuthTokens">> {
  const { config, redis } = app.ctx;
  const access_token = app.jwt.sign({ typ: "access" }, { sub: userId, expiresIn: config.ACCESS_TOKEN_TTL_S });
  const refresh_token = `rt_${randomBytes(32).toString("base64url")}`;
  await redis.set(refreshKey(refresh_token), userId, "EX", config.REFRESH_TOKEN_TTL_S);
  return { access_token, refresh_token, token_type: "Bearer", expires_in: config.ACCESS_TOKEN_TTL_S };
}

export async function register(app: FastifyInstance, input: Schema<"RegisterRequest">): Promise<Schema<"AuthSession">> {
  const ctx = app.ctx;
  if (!ctx.config.ALLOW_SIGNUP) throw forbidden("signup is disabled; ask an admin for an invite", "signup_disabled");
  const email = input.email.toLowerCase();
  if (await repo.findUserByEmail(ctx.db, email))
    throw conflict("an account with this email already exists", "email_taken");
  const user = { id: crypto.randomUUID(), email, name: input.name, password_hash: await hash(input.password) };
  const orgId = await repo.createUserWithOrg(ctx.db, user, input.org_name ?? `${input.name}'s workspace`);
  return { ...(await issueTokens(app, user.id)), user: { id: user.id, email, name: user.name }, org_id: orgId };
}

export async function login(app: FastifyInstance, input: Schema<"LoginRequest">): Promise<Schema<"AuthSession">> {
  const ctx = app.ctx;
  const user = await repo.findUserByEmail(ctx.db, input.email.toLowerCase());
  // Same answer for an unknown email and a wrong password: do not reveal which accounts exist.
  if (!user || !(await verify(user.password_hash, input.password))) throw unauthorized("incorrect email or password");
  const [first] = await repo.listMemberships(ctx.db, user.id);
  if (!first) throw forbidden("you are not a member of any organization", "no_organization");
  return {
    ...(await issueTokens(app, user.id)),
    user: { id: user.id, email: user.email, name: user.name },
    org_id: first.id,
  };
}

/** Rotate: the presented token is consumed atomically, so a stolen-and-replayed one fails. */
export async function refresh(app: FastifyInstance, refreshToken: string): Promise<Schema<"AuthTokens">> {
  const userId = await app.ctx.redis.getdel(refreshKey(refreshToken));
  if (!userId) throw unauthorized("refresh token is invalid, expired, or already used");
  return issueTokens(app, userId);
}

export const logout = async (ctx: Ctx, refreshToken: string): Promise<void> =>
  void (await ctx.redis.del(refreshKey(refreshToken)));
