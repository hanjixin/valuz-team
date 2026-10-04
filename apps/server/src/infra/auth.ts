/** Who is calling, and in which organization. */
import { type Auth, type Ctx } from "./context.ts";
import { forbidden, unauthorized } from "./errors.ts";
import type { FastifyRequest } from "fastify";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the caller's organization for this request: the one named by
 * `X-Org-Id`, otherwise the first they joined. The bearer token has already
 * been verified by the contract's security handler.
 */
export async function requireAuth(ctx: Ctx, req: FastifyRequest): Promise<Auth> {
  if (!req.userId) throw unauthorized();
  const header = req.headers["x-org-id"];
  const wanted = (Array.isArray(header) ? header[0] : header) || undefined;
  if (wanted !== undefined && !UUID.test(wanted)) throw forbidden("you are not a member of this organization");
  let query = ctx.db
    .selectFrom("org_members as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["m.org_id", "m.role", "u.name"])
    .where("m.user_id", "=", req.userId)
    .orderBy("m.joined_at")
    .limit(1);
  if (wanted) query = query.where("m.org_id", "=", wanted);
  const row = await query.executeTakeFirst();
  if (!row)
    throw wanted
      ? forbidden("you are not a member of this organization")
      : forbidden("you are not a member of any organization", "no_organization");
  return { userId: req.userId, name: row.name, orgId: row.org_id, role: row.role };
}
