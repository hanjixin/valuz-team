/** Projects — a shared workplace holding a team of deployed agents. */
import { permissionAtLeast } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aclParams, audit, permissionSql, requirePermission } from "../acl.ts";
import { withAuth } from "../auth.ts";
import type { Auth, Ctx } from "../context.ts";
import type { Row } from "../db.ts";
import { forbidden, notFound, parse, uuidParam } from "../http.ts";
import { shareRoutes } from "./shares.ts";

const ProjectCreate = z.object({
  name: z.string().min(1).max(256),
  kind: z.enum(["chat", "project"]).default("project"),
  icon: z.string().max(16).nullable().default(null),
  instructions_md: z.string().max(200_000).default(""),
  default_lead_agent_slug: z.string().nullable().default(null),
  /** The device whose folder backs this project, and the folder on it. */
  device_id: z.string().uuid().nullable().default(null),
  root_path: z.string().max(4096).nullable().default(null),
});

type Params = Record<string, string>;

export function projectRoutes(app: FastifyInstance, ctx: Ctx): void {
  const find = async (auth: Auth, id: string): Promise<Row> => {
    const row = await ctx.db.one(
      `SELECT * FROM (SELECT r.*, ${permissionSql("project")} AS permission FROM projects r WHERE r.org_id = $2::uuid AND r.id = $4) x WHERE permission IS NOT NULL`,
      [...aclParams(auth), uuidParam(id, "project")],
    );
    if (!row) throw notFound("project");
    return row;
  };
  const need = (row: Row, level: "use" | "edit" | "admin"): void => {
    if (!permissionAtLeast(row["permission"] as never, level)) throw forbidden(`this needs "${level}" permission on the project`);
  };
  const members = (projectId: string) =>
    ctx.db.query(
      `SELECT a.id, a.slug, a.name, a.description, a.avatar, a.runtime, a.model FROM project_members pm
         JOIN agents a ON a.id = pm.agent_id WHERE pm.project_id = $1 ORDER BY pm.created_at`,
      [projectId],
    );

  withAuth(app, ctx, (r) => {
    r.get("/v1/projects", async (req) => ({
      data: await ctx.db.query(
        `SELECT * FROM (SELECT r.*, ${permissionSql("project")} AS permission FROM projects r WHERE r.org_id = $2::uuid) x
          WHERE permission IS NOT NULL ORDER BY updated_at DESC`,
        aclParams(req.auth),
      ),
    }));

    r.post("/v1/projects", async (req, reply) => {
      const body = parse(ProjectCreate, req.body);
      if (body.device_id) await requirePermission(ctx.db, req.auth, "device", body.device_id, "use");
      const id = crypto.randomUUID();
      const row = await ctx.db.one(
        `INSERT INTO projects (id, org_id, owner_id, name, kind, icon, instructions_md, default_lead_agent_slug, device_id, root_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [id, req.auth.orgId, req.auth.userId, body.name, body.kind, body.icon, body.instructions_md, body.default_lead_agent_slug, body.device_id, body.root_path],
      );
      await audit(ctx.db, req.auth, "project.create", { type: "project", id });
      return reply.code(201).send({ ...row, permission: "admin", agents: [] });
    });

    r.get("/v1/projects/:id", async (req) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "");
      return { ...row, agents: await members(row["id"] as string) };
    });

    r.patch("/v1/projects/:id", async (req) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "");
      need(row, "edit");
      const body = parse(ProjectCreate.partial(), req.body) as Row;
      if (body["device_id"]) await requirePermission(ctx.db, req.auth, "device", body["device_id"] as string, "use");
      const names = Object.keys(body);
      if (names.length === 0) return row;
      const updated = await ctx.db.one(
        `UPDATE projects SET ${names.map((n, i) => `${n} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
        [row["id"], ...Object.values(body)],
      );
      return { ...updated, permission: row["permission"] };
    });

    r.delete("/v1/projects/:id", async (req, reply) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "");
      need(row, "admin");
      await ctx.db.tx(async (tx) => {
        await tx.query("DELETE FROM resource_shares WHERE resource_type = 'project' AND resource_id = $1", [row["id"]]);
        await tx.query("DELETE FROM projects WHERE id = $1", [row["id"]]);
      });
      await audit(ctx.db, req.auth, "project.delete", { type: "project", id: row["id"] as string });
      return reply.code(204).send();
    });

    // -- Team: deploy / remove agents (a live reference to the library agent) --
    r.get("/v1/projects/:id/agents", async (req) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "");
      return { data: await members(row["id"] as string) };
    });

    // `::` is a literal colon in the router — the path is /v1/projects/{id}/agents:deploy
    r.post("/v1/projects/:id/agents::deploy", async (req) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "");
      need(row, "edit");
      const { agent_slugs } = parse(z.object({ agent_slugs: z.array(z.string()).min(1) }), req.body);
      const agents = await ctx.db.query<{ id: string; slug: string; permission: string | null }>(
        `SELECT r.id, r.slug, ${permissionSql("agent")} AS permission FROM agents r WHERE r.org_id = $2::uuid AND r.slug = ANY($4::text[])`,
        [...aclParams(req.auth), agent_slugs],
      );
      const usable = agents.filter((a) => permissionAtLeast(a.permission as never, "use"));
      const missing = agent_slugs.filter((s) => !usable.some((a) => a.slug === s));
      if (missing.length) throw notFound(`agent(s) ${missing.join(", ")}`);
      await ctx.db.query(
        "INSERT INTO project_members (project_id, agent_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
        [row["id"], usable.map((a) => a.id)],
      );
      return { data: await members(row["id"] as string) };
    });

    r.delete("/v1/projects/:id/agents/:slug", async (req, reply) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "");
      need(row, "edit");
      await ctx.db.query(
        "DELETE FROM project_members WHERE project_id = $1 AND agent_id IN (SELECT id FROM agents WHERE org_id = $2 AND slug = $3)",
        [row["id"], req.auth.orgId, (req.params as Params)["slug"]],
      );
      return reply.code(204).send();
    });

    shareRoutes(r, ctx, "/v1/projects/:key", "project", async (auth, id) => (await find(auth, id))["id"] as string);
  });
}
