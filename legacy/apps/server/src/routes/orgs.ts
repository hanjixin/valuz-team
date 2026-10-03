/** Organizations, members, invites, teams, and the audit trail. */
import { OrgRole } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../acl.ts";
import { withAuth } from "../auth.ts";
import { type Auth, type Ctx, isOrgAdmin } from "../context.ts";
import { hashToken, newToken } from "../crypto.ts";
import { badRequest, conflict, forbidden, notFound, parse, uuidParam } from "../http.ts";

const requireAdmin = (auth: Auth): void => {
  if (!isOrgAdmin(auth)) throw forbidden("only organization owners and admins can do this");
};

type Params = Record<string, string>;

export function orgRoutes(app: FastifyInstance, ctx: Ctx): void {
  withAuth(app, ctx, (r) => {
    r.post("/v1/orgs", async (req, reply) => {
      const { name } = parse(z.object({ name: z.string().min(1).max(100) }), req.body);
      const id = crypto.randomUUID();
      await ctx.db.tx(async (tx) => {
        await tx.query("INSERT INTO orgs (id, name, created_by) VALUES ($1, $2, $3)", [id, name, req.auth.userId]);
        await tx.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [id, req.auth.userId]);
      });
      return reply.code(201).send({ id, name, role: "owner" });
    });

    r.patch("/v1/org", async (req) => {
      requireAdmin(req.auth);
      const { name } = parse(z.object({ name: z.string().min(1).max(100) }), req.body);
      return ctx.db.one("UPDATE orgs SET name = $2 WHERE id = $1 RETURNING id, name", [req.auth.orgId, name]);
    });

    // -- Members --
    r.get("/v1/org/members", async (req) => ({
      data: await ctx.db.query(
        `SELECT u.id, u.email, u.name, m.role, m.joined_at FROM org_members m JOIN users u ON u.id = m.user_id
          WHERE m.org_id = $1 ORDER BY m.joined_at`,
        [req.auth.orgId],
      ),
    }));

    r.patch("/v1/org/members/:userId", async (req) => {
      requireAdmin(req.auth);
      const userId = uuidParam((req.params as Params)["userId"], "member");
      const { role } = parse(z.object({ role: OrgRole }), req.body);
      // Only an owner may create or demote an owner.
      const target = await ctx.db.one<{ role: string }>("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2", [req.auth.orgId, userId]);
      if (!target) throw notFound("member");
      if ((role === "owner" || target.role === "owner") && req.auth.role !== "owner") throw forbidden("only an owner can change owner roles");
      await assertNotLastOwner(ctx, req.auth.orgId, userId, target.role, role);
      await ctx.db.query("UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2", [req.auth.orgId, userId, role]);
      await audit(ctx.db, req.auth, "member.role_change", { type: "user", id: userId }, { role });
      return { id: userId, role };
    });

    r.delete("/v1/org/members/:userId", async (req, reply) => {
      const userId = uuidParam((req.params as Params)["userId"], "member");
      if (userId !== req.auth.userId) requireAdmin(req.auth); // anyone may leave
      const target = await ctx.db.one<{ role: string }>("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2", [req.auth.orgId, userId]);
      if (!target) throw notFound("member");
      if (target.role === "owner" && req.auth.role !== "owner") throw forbidden("only an owner can remove an owner");
      await assertNotLastOwner(ctx, req.auth.orgId, userId, target.role, null);
      await ctx.db.tx(async (tx) => {
        await tx.query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [req.auth.orgId, userId]);
        // Leaving the org ends every grant made to that person inside it.
        await tx.query("DELETE FROM resource_shares WHERE org_id = $1 AND principal_type = 'user' AND principal_id = $2", [req.auth.orgId, userId]);
        await tx.query("DELETE FROM team_members WHERE user_id = $2 AND team_id IN (SELECT id FROM teams WHERE org_id = $1)", [req.auth.orgId, userId]);
        // Their devices stop being reachable by the org they left.
        await tx.query("UPDATE devices SET revoked_at = now() WHERE org_id = $1 AND owner_id = $2 AND revoked_at IS NULL", [req.auth.orgId, userId]);
      });
      await audit(ctx.db, req.auth, "member.remove", { type: "user", id: userId });
      return reply.code(204).send();
    });

    // -- Invites --
    r.post("/v1/org/invites", async (req, reply) => {
      requireAdmin(req.auth);
      const body = parse(z.object({ email: z.string().email().toLowerCase(), role: z.enum(["admin", "member"]).default("member") }), req.body);
      const already = await ctx.db.one(
        "SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2",
        [req.auth.orgId, body.email],
      );
      if (already) throw conflict("that person is already a member", "already_member");
      const token = newToken("inv");
      const id = crypto.randomUUID();
      await ctx.db.query(
        `INSERT INTO org_invites (id, org_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days')`,
        [id, req.auth.orgId, body.email, body.role, hashToken(token), req.auth.userId],
      );
      await audit(ctx.db, req.auth, "invite.create", { type: "invite", id }, { email: body.email, role: body.role });
      // The token is shown exactly once; only its hash is stored.
      return reply.code(201).send({ id, email: body.email, role: body.role, token });
    });

    r.get("/v1/org/invites", async (req) => {
      requireAdmin(req.auth);
      return {
        data: await ctx.db.query(
          "SELECT id, email, role, expires_at, created_at FROM org_invites WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC",
          [req.auth.orgId],
        ),
      };
    });

    r.delete("/v1/org/invites/:id", async (req, reply) => {
      requireAdmin(req.auth);
      await ctx.db.query("DELETE FROM org_invites WHERE org_id = $1 AND id = $2", [req.auth.orgId, uuidParam((req.params as Params)["id"])]);
      return reply.code(204).send();
    });

    // -- Teams --
    r.get("/v1/org/teams", async (req) => ({
      data: await ctx.db.query(
        `SELECT t.id, t.name, COALESCE(array_agg(tm.user_id) FILTER (WHERE tm.user_id IS NOT NULL), '{}') AS member_ids
           FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id WHERE t.org_id = $1 GROUP BY t.id ORDER BY t.name`,
        [req.auth.orgId],
      ),
    }));

    r.post("/v1/org/teams", async (req, reply) => {
      requireAdmin(req.auth);
      const { name } = parse(z.object({ name: z.string().min(1).max(100) }), req.body);
      const dup = await ctx.db.one("SELECT 1 FROM teams WHERE org_id = $1 AND name = $2", [req.auth.orgId, name]);
      if (dup) throw conflict("a team with this name already exists");
      const id = crypto.randomUUID();
      await ctx.db.query("INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)", [id, req.auth.orgId, name]);
      return reply.code(201).send({ id, name, member_ids: [] });
    });

    r.put("/v1/org/teams/:id/members", async (req) => {
      requireAdmin(req.auth);
      const teamId = uuidParam((req.params as Params)["id"], "team");
      const { user_ids } = parse(z.object({ user_ids: z.array(z.string().uuid()) }), req.body);
      const team = await ctx.db.one("SELECT 1 FROM teams WHERE org_id = $1 AND id = $2", [req.auth.orgId, teamId]);
      if (!team) throw notFound("team");
      const members = await ctx.db.query<{ user_id: string }>("SELECT user_id FROM org_members WHERE org_id = $1 AND user_id = ANY($2::uuid[])", [req.auth.orgId, user_ids]);
      if (members.length !== new Set(user_ids).size) throw badRequest("every team member must belong to the organization");
      await ctx.db.tx(async (tx) => {
        await tx.query("DELETE FROM team_members WHERE team_id = $1", [teamId]);
        if (user_ids.length) await tx.query("INSERT INTO team_members (team_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING", [teamId, user_ids]);
      });
      return { id: teamId, member_ids: [...new Set(user_ids)] };
    });

    r.delete("/v1/org/teams/:id", async (req, reply) => {
      requireAdmin(req.auth);
      const teamId = uuidParam((req.params as Params)["id"], "team");
      await ctx.db.tx(async (tx) => {
        await tx.query("DELETE FROM resource_shares WHERE org_id = $1 AND principal_type = 'team' AND principal_id = $2", [req.auth.orgId, teamId]);
        await tx.query("DELETE FROM teams WHERE org_id = $1 AND id = $2", [req.auth.orgId, teamId]);
      });
      return reply.code(204).send();
    });

    r.get("/v1/org/audit-logs", async (req) => {
      requireAdmin(req.auth);
      const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional() }), req.query);
      return {
        data: await ctx.db.query(
          `SELECT a.id, a.action, a.resource_type, a.resource_id, a.detail, a.created_at, a.actor_id, u.name AS actor_name
             FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
            WHERE a.org_id = $1 AND ($2::bigint IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $3`,
          [req.auth.orgId, q.before ?? null, q.limit],
        ),
      };
    });
  });
}

/** An organization must always keep at least one owner. */
async function assertNotLastOwner(ctx: Ctx, orgId: string, userId: string, current: string, next: string | null): Promise<void> {
  if (current !== "owner" || next === "owner") return;
  const others = await ctx.db.one<{ n: number }>(
    "SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner' AND user_id <> $2",
    [orgId, userId],
  );
  if ((others?.n ?? 0) === 0) throw conflict("an organization must keep at least one owner", "last_owner");
}
