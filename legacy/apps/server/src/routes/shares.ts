import { type ResourceType, ShareInput } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { audit, listShares, putShare, requirePermission } from "../acl.ts";
import type { Auth, Ctx } from "../context.ts";
import { parse, uuidParam } from "../http.ts";

/**
 * `GET/PUT {base}/shares` and `DELETE {base}/shares/:shareId` for one resource
 * type. Managing shares needs `admin` (the owner or an org admin).
 * `resolveId` maps the route key (an id or a slug) to the row id.
 */
export function shareRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  base: string,
  type: ResourceType,
  resolveId: (auth: Auth, key: string) => Promise<string>,
): void {
  const idOf = (req: { auth: Auth; params: unknown }) => resolveId(req.auth, (req.params as Record<string, string>)["key"] ?? "");

  app.get(`${base}/shares`, async (req) => {
    const id = await idOf(req);
    await requirePermission(ctx.db, req.auth, type, id, "admin");
    return { data: await listShares(ctx.db, type, id) };
  });

  app.put(`${base}/shares`, async (req) => {
    const id = await idOf(req);
    await requirePermission(ctx.db, req.auth, type, id, "admin");
    const input = parse(ShareInput, req.body);
    const share = await putShare(ctx.db, req.auth, type, id, input);
    await audit(ctx.db, req.auth, "share.grant", { type, id }, input);
    return share;
  });

  app.delete(`${base}/shares/:shareId`, async (req, reply) => {
    const id = await idOf(req);
    await requirePermission(ctx.db, req.auth, type, id, "admin");
    const shareId = uuidParam((req.params as Record<string, string>)["shareId"], "share");
    await ctx.db.query("DELETE FROM resource_shares WHERE id = $1 AND resource_type = $2 AND resource_id = $3", [shareId, type, id]);
    await audit(ctx.db, req.auth, "share.revoke", { type, id }, { share_id: shareId });
    return reply.code(204).send();
  });
}
