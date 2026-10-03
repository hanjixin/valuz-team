/** IM channel bindings (managed through the project they run in) and the platform's event callback. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, requirePermission } from "../acl.ts";
import { withAuth } from "../auth.ts";
import type { ChannelSecrets } from "../channels.ts";
import type { Auth, Ctx } from "../context.ts";
import type { Row } from "../db.ts";
import { badRequest, notFound, parse, uuidParam } from "../http.ts";

const Body = z.object({
  name: z.string().min(1).max(128),
  project_id: z.string().uuid(),
  agent_slug: z.string().min(1),
  app_id: z.string().min(1).max(128),
  app_secret: z.string().min(1).max(256),
  verification_token: z.string().max(256).optional(),
  encrypt_key: z.string().max(256).optional(),
  api_base: z.string().url().or(z.literal("")).default(""),
  /** `websocket`: the server keeps a long connection to the platform (no public URL needed). `webhook`: the platform calls `callback_url`. */
  mode: z.enum(["webhook", "websocket"]).default("websocket"),
  enabled: z.boolean().default(true),
});

type Params = Record<string, string>;

export function channelRoutes(app: FastifyInstance, ctx: Ctx): void {
  // Called by the platform, authenticated by its signature / verification token.
  app.post("/v1/channels/feishu/:id/callback", async (req) =>
    ctx.channels.callback(uuidParam((req.params as Params)["id"], "channel"), req.headers, (req.body ?? {}) as Record<string, unknown>),
  );

  const present = (row: Row) => {
    const { secret_enc: _secret, ...rest } = row;
    if (row["mode"] === "websocket") return { ...rest, callback_url: null, link: ctx.channels.linkStatus(row["id"] as string) };
    return { ...rest, callback_url: `${ctx.config.PUBLIC_URL}/v1/channels/feishu/${String(row["id"])}/callback`, link: null };
  };
  const find = async (auth: Auth, id: string): Promise<Row> => {
    const row = await ctx.db.one("SELECT * FROM channels WHERE id = $1 AND org_id = $2", [uuidParam(id, "channel"), auth.orgId]);
    if (!row) throw notFound("channel");
    await requirePermission(ctx.db, auth, "project", row["project_id"] as string, "edit");
    return row;
  };
  const assertMember = async (projectId: string, slug: string): Promise<void> => {
    const ok = await ctx.db.one("SELECT 1 FROM project_members pm JOIN agents a ON a.id = pm.agent_id WHERE pm.project_id = $1 AND a.slug = $2", [projectId, slug]);
    if (!ok) throw badRequest(`agent "${slug}" is not deployed to this project`, "agent_unavailable");
  };
  /** Without either, anyone who learns the callback URL could post forged messages. */
  /** The SDK refuses to dial with a malformed App ID and only logs it; say so up front instead. */
  const assertDialable = (mode: unknown, appId: unknown): void => {
    if (mode === "websocket" && !/^cli_[0-9a-fA-F]{16}$/.test(String(appId))) {
      throw badRequest('the App ID must look like "cli_" followed by 16 hex characters (copy it from the app\'s credentials page)', "invalid_app_id");
    }
  };
  const assertVerifiable = (mode: unknown, s: ChannelSecrets): void => {
    // A long connection is authenticated by the app credentials themselves.
    if (mode === "webhook" && !s.verification_token && !s.encrypt_key) throw badRequest("set the app's Verification Token or Encrypt Key so events can be authenticated", "unverifiable_channel");
  };

  withAuth(app, ctx, (r) => {
    r.get("/v1/projects/:id/channels", async (req) => {
      const projectId = uuidParam((req.params as Params)["id"], "project");
      await requirePermission(ctx.db, req.auth, "project", projectId, "edit");
      return { data: (await ctx.db.query("SELECT * FROM channels WHERE project_id = $1 ORDER BY created_at", [projectId])).map(present) };
    });

    r.post("/v1/channels", async (req, reply) => {
      const body = parse(Body, req.body);
      await requirePermission(ctx.db, req.auth, "project", body.project_id, "edit");
      await assertMember(body.project_id, body.agent_slug);
      const secrets: ChannelSecrets = { app_secret: body.app_secret, verification_token: body.verification_token || undefined, encrypt_key: body.encrypt_key || undefined };
      assertVerifiable(body.mode, secrets);
      assertDialable(body.mode, body.app_id);
      const id = crypto.randomUUID();
      const row = (await ctx.db.one(
        `INSERT INTO channels (id, org_id, owner_id, project_id, platform, name, agent_slug, app_id, secret_enc, api_base, enabled, mode)
         VALUES ($1, $2, $3, $4, 'feishu', $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [id, req.auth.orgId, req.auth.userId, body.project_id, body.name, body.agent_slug, body.app_id, ctx.box.seal("channel", JSON.stringify(secrets)), body.api_base, body.enabled, body.mode],
      )) as Row;
      await ctx.channels.sync(id);
      await audit(ctx.db, req.auth, "channel.create", { type: "channel", id }, { platform: "feishu", app_id: body.app_id, mode: body.mode });
      return reply.code(201).send(present(row));
    });

    r.patch("/v1/channels/:id", async (req) => {
      const existing = await find(req.auth, (req.params as Params)["id"] ?? "");
      const body = parse(Body.omit({ project_id: true }).partial(), req.body);
      if (body.agent_slug) await assertMember(existing["project_id"] as string, body.agent_slug);
      const prior = ctx.channels.secrets(existing);
      // An omitted secret keeps its stored value; an empty string clears it.
      const secrets: ChannelSecrets = {
        app_secret: body.app_secret ?? prior.app_secret,
        verification_token: body.verification_token === undefined ? prior.verification_token : body.verification_token || undefined,
        encrypt_key: body.encrypt_key === undefined ? prior.encrypt_key : body.encrypt_key || undefined,
      };
      const mode = body.mode ?? existing["mode"];
      assertVerifiable(mode, secrets);
      assertDialable(mode, body.app_id ?? existing["app_id"]);
      const row = (await ctx.db.one(
        `UPDATE channels SET name = $2, agent_slug = $3, app_id = $4, secret_enc = $5, api_base = $6, enabled = $7, mode = $8, updated_at = now() WHERE id = $1 RETURNING *`,
        [
          existing["id"], body.name ?? existing["name"], body.agent_slug ?? existing["agent_slug"], body.app_id ?? existing["app_id"],
          ctx.box.seal("channel", JSON.stringify(secrets)), body.api_base ?? existing["api_base"], body.enabled ?? existing["enabled"], mode,
        ],
      )) as Row;
      await ctx.channels.sync(existing["id"] as string);
      return present(row);
    });

    r.post("/v1/channels/:id/test", async (req) => {
      await ctx.channels.test(await find(req.auth, (req.params as Params)["id"] ?? ""));
      return { ok: true };
    });

    r.delete("/v1/channels/:id", async (req, reply) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "");
      await ctx.db.query("DELETE FROM channels WHERE id = $1", [row["id"]]);
      await ctx.channels.sync(row["id"] as string);
      await audit(ctx.db, req.auth, "channel.delete", { type: "channel", id: row["id"] as string });
      return reply.code(204).send();
    });
  });
}
