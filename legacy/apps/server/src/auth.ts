/** Token issuing and the request auth hook. */
import { OrgRole } from "@agent-base/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { Auth, Ctx } from "./context.ts";
import { hashToken, newToken } from "./crypto.ts";
import { HttpError, forbidden, isUuid, unauthorized } from "./http.ts";

const secretKey = (ctx: Ctx) => new TextEncoder().encode(ctx.config.APP_SECRET);

export async function issueTokens(ctx: Ctx, userId: string) {
  const access_token = await new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ctx.config.ACCESS_TOKEN_TTL_S}s`)
    .sign(secretKey(ctx));
  const refresh_token = newToken("rt");
  await ctx.pubsub.redis.set(`rt:${hashToken(refresh_token)}`, userId, "EX", ctx.config.REFRESH_TOKEN_TTL_S);
  return { access_token, refresh_token, token_type: "Bearer", expires_in: ctx.config.ACCESS_TOKEN_TTL_S };
}

/** Rotate: a refresh token is single-use, so a stolen-and-replayed one fails. */
export async function rotateRefreshToken(ctx: Ctx, refreshToken: string) {
  const userId = await ctx.pubsub.redis.getdel(`rt:${hashToken(refreshToken)}`);
  if (!userId) throw unauthorized("refresh token is invalid or expired");
  return issueTokens(ctx, userId);
}

export const revokeRefreshToken = (ctx: Ctx, refreshToken: string) =>
  ctx.pubsub.redis.del(`rt:${hashToken(refreshToken)}`);

async function verifyAccess(ctx: Ctx, token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, secretKey(ctx), { algorithms: ["HS256"] });
    if (payload["typ"] !== "access" || !payload.sub) throw new Error("wrong token type");
    return payload.sub;
  } catch {
    throw unauthorized("access token is invalid or expired");
  }
}

const bearer = (req: FastifyRequest): string | null => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  // EventSource cannot set headers; streams may pass the token in the query.
  const q = (req.query as Record<string, unknown> | undefined)?.["access_token"];
  return typeof q === "string" ? q : null;
};

/** Resolve the caller and their organization (`X-Org-Id`, else their first org). */
export async function authenticate(ctx: Ctx, req: FastifyRequest): Promise<Auth> {
  const token = bearer(req);
  if (!token) throw unauthorized();
  const userId = await verifyAccess(ctx, token);
  // An empty header means "no preference", same as leaving it out.
  const wanted = (req.headers["x-org-id"] || (req.query as Record<string, unknown> | undefined)?.["org_id"]) || undefined;
  if (wanted !== undefined && !isUuid(wanted)) throw forbidden("you are not a member of this organization");
  const row = await ctx.db.one<{ org_id: string; role: string; name: string }>(
    `SELECT m.org_id, m.role, u.name FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND ($2::uuid IS NULL OR m.org_id = $2::uuid)
      ORDER BY m.joined_at LIMIT 1`,
    [userId, wanted ?? null],
  );
  if (!row) {
    if (wanted) throw forbidden("you are not a member of this organization");
    throw new HttpError(403, "no_organization", "you are not a member of any organization");
  }
  return { userId, name: row.name, orgId: row.org_id, role: OrgRole.parse(row.role) };
}

/** Routes registered inside `fn` require a signed-in org member. */
export function withAuth(app: FastifyInstance, ctx: Ctx, fn: (app: FastifyInstance) => void): void {
  void app.register(async (scoped) => {
    scoped.addHook("preHandler", async (req) => {
      req.auth = await authenticate(ctx, req);
    });
    fn(scoped);
  });
}
