import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../acl.ts";
import { issueTokens, revokeRefreshToken, rotateRefreshToken, withAuth } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { hashPassword, hashToken, verifyPassword } from "../crypto.ts";
import type { Queryable } from "../db.ts";
import { HttpError, conflict, forbidden, parse, unauthorized } from "../http.ts";

const Credentials = z.object({ email: z.string().email().toLowerCase(), password: z.string().min(8).max(200) });
const Register = Credentials.extend({
  name: z.string().min(1).max(100),
  org_name: z.string().min(1).max(100).optional(),
  /** Joining through an invite works even when open signup is disabled. */
  invite_token: z.string().optional(),
});

/** Consume an invite for `email`, adding the user to the inviting org. */
export async function acceptInvite(tx: Queryable, userId: string, email: string, token: string): Promise<string> {
  const invite = await tx.one<{ id: string; org_id: string; role: string; email: string }>(
    "SELECT id, org_id, role, email FROM org_invites WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE",
    [hashToken(token)],
  );
  if (!invite) throw new HttpError(400, "invalid_invite", "this invite is invalid, expired, or already used");
  if (invite.email !== email) throw forbidden("this invite was issued to a different email address");
  await tx.query(
    "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING",
    [invite.org_id, userId, invite.role],
  );
  await tx.query("UPDATE org_invites SET accepted_at = now() WHERE id = $1", [invite.id]);
  return invite.org_id;
}

export function authRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post("/v1/auth/register", async (req, reply) => {
    const body = parse(Register, req.body);
    if (!ctx.config.ALLOW_SIGNUP && !body.invite_token) throw forbidden("signup is disabled; ask an admin for an invite");
    const password_hash = await hashPassword(body.password);
    const userId = crypto.randomUUID();
    const orgId = await ctx.db.tx(async (tx) => {
      const exists = await tx.one("SELECT 1 FROM users WHERE email = $1", [body.email]);
      if (exists) throw conflict("an account with this email already exists", "email_taken");
      await tx.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)", [userId, body.email, body.name, password_hash]);
      if (body.invite_token) return acceptInvite(tx, userId, body.email, body.invite_token);
      const id = crypto.randomUUID();
      await tx.query("INSERT INTO orgs (id, name, created_by) VALUES ($1, $2, $3)", [id, body.org_name ?? `${body.name}'s workspace`, userId]);
      await tx.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [id, userId]);
      return id;
    });
    await audit(ctx.db, { userId, orgId }, "user.register");
    return reply.code(201).send({ user: { id: userId, email: body.email, name: body.name }, org_id: orgId, ...(await issueTokens(ctx, userId)) });
  });

  app.post("/v1/auth/login", async (req) => {
    const body = parse(Credentials, req.body);
    // Throttle guessing per account: 10 failures locks it for 15 minutes.
    const key = `login-fail:${body.email}`;
    if (Number(await ctx.pubsub.redis.get(key)) >= 10) {
      throw new HttpError(429, "too_many_attempts", "too many failed sign-ins; try again in a few minutes");
    }
    const user = await ctx.db.one<{ id: string; name: string; password_hash: string }>(
      "SELECT id, name, password_hash FROM users WHERE email = $1",
      [body.email],
    );
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      await ctx.pubsub.redis.multi().incr(key).expire(key, 900).exec();
      throw unauthorized("incorrect email or password");
    }
    await ctx.pubsub.redis.del(key);
    return { user: { id: user.id, email: body.email, name: user.name }, ...(await issueTokens(ctx, user.id)) };
  });

  app.post("/v1/auth/refresh", async (req) => rotateRefreshToken(ctx, parse(z.object({ refresh_token: z.string() }), req.body).refresh_token));

  app.post("/v1/auth/logout", async (req, reply) => {
    await revokeRefreshToken(ctx, parse(z.object({ refresh_token: z.string() }), req.body).refresh_token);
    return reply.code(204).send();
  });

  withAuth(app, ctx, (authed) => {
    authed.get("/v1/me", async (req) => {
      const user = await ctx.db.one("SELECT id, email, name, created_at FROM users WHERE id = $1", [req.auth.userId]);
      const orgs = await ctx.db.query(
        "SELECT o.id, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY m.joined_at",
        [req.auth.userId],
      );
      return { user, orgs, current_org_id: req.auth.orgId, role: req.auth.role };
    });

    authed.post("/v1/invites/accept", async (req) => {
      const { token } = parse(z.object({ token: z.string() }), req.body);
      const user = await ctx.db.one<{ email: string }>("SELECT email FROM users WHERE id = $1", [req.auth.userId]);
      const orgId = await ctx.db.tx((tx) => acceptInvite(tx, req.auth.userId, user?.email ?? "", token));
      await audit(ctx.db, { userId: req.auth.userId, orgId }, "member.join");
      return { org_id: orgId };
    });
  });
}
