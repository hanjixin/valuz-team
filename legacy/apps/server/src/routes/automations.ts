/** Scheduled automations, managed per project (`edit` on the project to change them). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, requirePermission } from "../acl.ts";
import { withAuth } from "../auth.ts";
import type { Auth, Ctx } from "../context.ts";
import type { Row } from "../db.ts";
import { badRequest, notFound, parse, uuidParam } from "../http.ts";

const Body = z.object({
  name: z.string().min(1).max(128),
  agent_slug: z.string().min(1),
  prompt: z.string().min(1).max(100_000),
  /** Standard 5-field cron (or 6 with seconds). */
  cron: z.string().min(1).max(128),
  timezone: z.string().max(64).default("UTC"),
  enabled: z.boolean().default(true),
});

type Params = Record<string, string>;

export function automationRoutes(app: FastifyInstance, ctx: Ctx): void {
  const find = async (auth: Auth, id: string, needed: "view" | "edit"): Promise<Row> => {
    const row = await ctx.db.one("SELECT * FROM automations WHERE id = $1 AND org_id = $2", [uuidParam(id, "automation"), auth.orgId]);
    if (!row) throw notFound("automation");
    await requirePermission(ctx.db, auth, "project", row["project_id"] as string, needed);
    return row;
  };
  const assertMember = async (projectId: string, slug: string): Promise<void> => {
    const member = await ctx.db.one("SELECT 1 FROM project_members pm JOIN agents a ON a.id = pm.agent_id WHERE pm.project_id = $1 AND a.slug = $2", [projectId, slug]);
    if (!member) throw badRequest(`agent "${slug}" is not deployed to this project`, "agent_unavailable");
  };
  const present = async (row: Row) => ({ ...row, next_run_at: row["enabled"] ? await ctx.automations.nextRun(row["id"] as string) : null });

  withAuth(app, ctx, (r) => {
    r.get("/v1/projects/:id/automations", async (req) => {
      const projectId = uuidParam((req.params as Params)["id"], "project");
      await requirePermission(ctx.db, req.auth, "project", projectId, "view");
      const rows = await ctx.db.query("SELECT * FROM automations WHERE project_id = $1 ORDER BY created_at", [projectId]);
      return { data: await Promise.all(rows.map(present)) };
    });

    r.post("/v1/projects/:id/automations", async (req, reply) => {
      const projectId = uuidParam((req.params as Params)["id"], "project");
      await requirePermission(ctx.db, req.auth, "project", projectId, "edit");
      const body = parse(Body, req.body);
      await assertMember(projectId, body.agent_slug);
      const id = crypto.randomUUID();
      const row = (await ctx.db.one(
        `INSERT INTO automations (id, org_id, owner_id, project_id, name, agent_slug, prompt, cron, timezone, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [id, req.auth.orgId, req.auth.userId, projectId, body.name, body.agent_slug, body.prompt, body.cron, body.timezone, body.enabled],
      )) as Row;
      try {
        await ctx.automations.sync(row);
      } catch (err) {
        await ctx.db.query("DELETE FROM automations WHERE id = $1", [id]);
        throw err;
      }
      await audit(ctx.db, req.auth, "automation.create", { type: "automation", id }, { cron: body.cron });
      return reply.code(201).send(await present(row));
    });

    r.patch("/v1/automations/:id", async (req) => {
      const existing = await find(req.auth, (req.params as Params)["id"] ?? "", "edit");
      const body = parse(Body.partial(), req.body) as Row;
      if (body["agent_slug"]) await assertMember(existing["project_id"] as string, body["agent_slug"] as string);
      const names = Object.keys(body);
      if (names.length === 0) return present(existing);
      // Validate the new schedule in Redis before the row changes.
      await ctx.automations.sync({ ...existing, ...body });
      const row = (await ctx.db.one(
        `UPDATE automations SET ${names.map((n, i) => `${n} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
        [existing["id"], ...Object.values(body)],
      )) as Row;
      return present(row);
    });

    r.delete("/v1/automations/:id", async (req, reply) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "", "edit");
      await ctx.automations.remove(row["id"] as string);
      await ctx.db.query("DELETE FROM automations WHERE id = $1", [row["id"]]);
      await audit(ctx.db, req.auth, "automation.delete", { type: "automation", id: row["id"] as string });
      return reply.code(204).send();
    });

    r.post("/v1/automations/:id/run", async (req, reply) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "", "edit");
      await ctx.automations.runNow(row["id"] as string);
      return reply.code(202).send({ queued: true });
    });

    r.get("/v1/automations/:id/runs", async (req) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "", "view");
      return { data: await ctx.db.query("SELECT * FROM automation_runs WHERE automation_id = $1 ORDER BY started_at DESC LIMIT 50", [row["id"]]) };
    });
  });
}
