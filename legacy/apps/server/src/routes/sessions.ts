/**
 * Sessions — created in the cloud, executed on a device, watched and driven by
 * anyone with access. The server keeps no secrets in a session row: the model
 * credential, connector credentials, and skill bundles are resolved from the
 * shared library every time a turn is dispatched.
 */
import {
  AgentConfig,
  Attachment,
  type McpServerConfig,
  McpServerConfig as McpServerConfigSchema,
  type ModelProvider,
  ModelSettings,
  type Permission,
  PermissionMode,
  Session,
  SessionMode,
  type SkillBundle,
  type StoredEvent,
  SubmitAction,
  maxPermission,
  permissionAtLeast,
} from "@agent-base/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { aclParams, audit, getPermission, permissionSql, requirePermission } from "../acl.ts";
import { withAuth } from "../auth.ts";
import type { Auth, Ctx } from "../context.ts";
import { type Row, json } from "../db.ts";
import { orgChannel, sessionChannel } from "../device-hub.ts";
import { HttpError, badRequest, conflict, forbidden, notFound, parse, uuidParam } from "../http.ts";
import { createSession, dispatchTurn, drainQueue } from "../dispatch.ts";
import { shareRoutes } from "./shares.ts";

const CreateSession = z.object({
  agent_slug: z.string(),
  device_id: z.string().uuid().optional(),
  project_id: z.string().uuid().nullable().default(null),
  cwd: z.string().max(4096).optional(),
  title: z.string().max(256).default(""),
  model: z.string().max(128).optional(),
  provider_id: z.string().uuid().nullable().optional(),
  model_settings: ModelSettings.nullable().default(null),
  permission_mode: PermissionMode.optional(),
  mode: SessionMode.default("default"),
  metadata: z.record(z.unknown()).default({}),
});

const SendMessage = z.object({
  text: z.string().min(1).max(1_000_000),
  attachments: z.array(Attachment).default([]),
  additional_context: z.string().default(""),
});

type Params = Record<string, string>;

/**
 * A session's effective permission also flows from where it lives:
 * `edit` on its project lets a teammate drive it, `view`/`use` lets them
 * watch; `control` on its device lets them drive anything running there.
 */
async function sessionAccess(ctx: Ctx, auth: Auth, id: string): Promise<{ row: Row; permission: Permission }> {
  const row = await ctx.db.one(
    `SELECT r.*, ${permissionSql("session")} AS permission FROM sessions r WHERE r.org_id = $2::uuid AND r.id = $4`,
    [...aclParams(auth), uuidParam(id, "session")],
  );
  if (!row) throw notFound("session");
  let permission = (row["permission"] as Permission | null) ?? null;
  if (permission !== "admin" && row["project_id"]) {
    const p = await getPermission(ctx.db, auth, "project", row["project_id"] as string);
    permission = maxPermission(permission, p ? (permissionAtLeast(p, "edit") ? "control" : "view") : null);
  }
  if (permission !== "admin" && row["device_id"]) {
    const d = await getPermission(ctx.db, auth, "device", row["device_id"] as string);
    if (permissionAtLeast(d, "control")) permission = maxPermission(permission, "control");
  }
  if (!permission) throw notFound("session");
  return { row, permission };
}

const needControl = (permission: Permission): void => {
  if (!permissionAtLeast(permission, "control")) throw forbidden('driving this session needs "control" permission');
};

/** Server-Sent Events: replay from Postgres, then follow Redis — gap-free. */
export async function streamEvents(
  ctx: Ctx,
  req: FastifyRequest,
  reply: FastifyReply,
  channel: string,
  replay: ((afterSeq: number) => Promise<{ seq: number; type: string }[]>) | null,
): Promise<void> {
  const q = req.query as Record<string, string | undefined>;
  let cursor = Number(req.headers["last-event-id"] ?? q["after_seq"] ?? 0) || 0;
  reply.hijack();
  const origin = req.headers.origin;
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
  });
  const write = (e: { seq?: number; type: string }): void => {
    reply.raw.write(`${e.seq !== undefined ? `id: ${e.seq}\n` : ""}event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };

  // Subscribe first and buffer, so nothing published during the replay is lost.
  let buffer: StoredEvent[] | null = [];
  const unsubscribe = await ctx.pubsub.subscribe(channel, (payload) => {
    const event = payload as StoredEvent;
    if (buffer) return void buffer.push(event);
    if (event.seq === undefined || event.seq > cursor) {
      if (event.seq !== undefined) cursor = event.seq;
      write(event);
    }
  });
  const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  if (replay) {
    for (;;) {
      const page = await replay(cursor);
      for (const event of page) {
        cursor = event.seq;
        write(event);
      }
      if (page.length < 500) break;
    }
  }
  for (const event of buffer) {
    if (event.seq === undefined || event.seq > cursor) {
      if (event.seq !== undefined) cursor = event.seq;
      write(event);
    }
  }
  buffer = null;
}

export function sessionRoutes(app: FastifyInstance, ctx: Ctx): void {
  const eventsAfter = (sessionId: string, afterSeq: number, limit: number) =>
    ctx.db.query<StoredEvent>(
      `SELECT seq, session_id, message_id, type, data, ts AS timestamp, event_uid FROM events
        WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [sessionId, afterSeq, limit],
    );

  withAuth(app, ctx, (r) => {
    r.post("/v1/sessions", async (req, reply) => {
      const body = parse(CreateSession, req.body);
      const agent = await ctx.db.one<Row>(
        `SELECT * FROM (SELECT r.*, ${permissionSql("agent")} AS permission FROM agents r WHERE r.org_id = $2::uuid AND r.slug = $4) x WHERE permission IS NOT NULL`,
        [...aclParams(req.auth), body.agent_slug],
      );
      if (!agent) throw notFound("agent");
      if (!permissionAtLeast(agent["permission"] as never, "use")) throw forbidden('running this agent needs "use" permission');

      const project = body.project_id
        ? await ctx.db.one<{ device_id: string | null; root_path: string | null }>("SELECT device_id, root_path FROM projects WHERE id = $1 AND org_id = $2", [body.project_id, req.auth.orgId])
        : null;
      if (body.project_id) await requirePermission(ctx.db, req.auth, "project", body.project_id, "use");

      const deviceId = body.device_id ?? project?.device_id ?? null;
      if (!deviceId) throw badRequest("device_id is required (the project has no device bound)", "device_required");
      await requirePermission(ctx.db, req.auth, "device", deviceId, "use");
      const cwd = body.cwd ?? project?.root_path ?? null;
      if (!cwd) throw badRequest("cwd is required (the project has no folder bound)", "cwd_required");

      const providerId = body.provider_id === undefined ? (agent["provider_id"] as string | null) : body.provider_id;
      if (providerId) await requirePermission(ctx.db, req.auth, "provider", providerId, "use");
      const row = await createSession(ctx, {
        orgId: req.auth.orgId,
        ownerId: req.auth.userId,
        agent,
        deviceId,
        projectId: body.project_id,
        providerId,
        cwd,
        title: body.title,
        model: body.model,
        modelSettings: body.model_settings,
        permissionMode: body.permission_mode,
        mode: body.mode,
        metadata: body.metadata,
      });
      const id = row["id"] as string;
      await audit(ctx.db, req.auth, "session.create", { type: "session", id }, { device_id: deviceId, agent: body.agent_slug });
      return reply.code(201).send({ ...row, permission: "admin" });
    });

    r.get("/v1/sessions", async (req) => {
      const q = parse(
        z.object({ project_id: z.string().uuid().optional(), device_id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
        req.query,
      );
      // Visible = mine, shared with me, in a project I can see, or on a device I control.
      return {
        data: await ctx.db.query(
          `SELECT * FROM (
             SELECT r.id, r.owner_id, r.device_id, r.project_id, r.agent_id, r.title, r.runtime_provider, r.model, r.status, r.mode,
                    r.created_at, r.updated_at, u.name AS owner_name, r.agent_config->>'name' AS agent_name,
                    ${permissionSql("session")} AS p_session, ${permissionSql("project", "p")} AS p_project, ${permissionSql("device", "d")} AS p_device
               FROM sessions r JOIN users u ON u.id = r.owner_id
               LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN devices d ON d.id = r.device_id
              WHERE r.org_id = $2::uuid AND ($4::uuid IS NULL OR r.project_id = $4) AND ($5::uuid IS NULL OR r.device_id = $5)) x
            WHERE p_session IS NOT NULL OR p_project IS NOT NULL OR p_device IN ('control', 'admin')
            ORDER BY updated_at DESC LIMIT $6`,
          [...aclParams(req.auth), q.project_id ?? null, q.device_id ?? null, q.limit],
        ),
      };
    });

    r.get("/v1/sessions/:id", async (req) => {
      const { row, permission } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      return { ...row, permission };
    });

    r.patch("/v1/sessions/:id", async (req) => {
      const { row, permission } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      needControl(permission);
      const body = parse(z.object({ title: z.string().max(256), permission_mode: PermissionMode, mode: SessionMode }).partial(), req.body) as Row;
      const names = Object.keys(body);
      if (names.length === 0) return { ...row, permission };
      const updated = await ctx.db.one(
        `UPDATE sessions SET ${names.map((n, i) => `${n} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
        [row["id"], ...Object.values(body)],
      );
      return { ...updated, permission };
    });

    r.delete("/v1/sessions/:id", async (req, reply) => {
      const { row, permission } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      if (permission !== "admin") throw forbidden("only the session owner or an org admin can delete it");
      if (row["device_id"]) {
        // Best effort: an offline device simply keeps a stale checkpoint.
        await ctx.hub.call(row["device_id"] as string, "session.close", { session_id: row["id"] as string }, { user_id: req.auth.userId, name: req.auth.name }, 5000).catch(() => undefined);
      }
      await ctx.db.tx(async (tx) => {
        await tx.query("DELETE FROM resource_shares WHERE resource_type = 'session' AND resource_id = $1", [row["id"]]);
        await tx.query("DELETE FROM sessions WHERE id = $1", [row["id"]]);
      });
      return reply.code(204).send();
    });

    // -- Turns --
    r.post("/v1/sessions/:id/messages", async (req, reply) => {
      const { row, permission } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      needControl(permission);
      const body = parse(SendMessage, req.body);
      const messageId = await dispatchTurn(ctx, row, body, { user_id: req.auth.userId, name: req.auth.name });
      if (row["owner_id"] !== req.auth.userId) {
        await audit(ctx.db, req.auth, "session.remote_send", { type: "session", id: row["id"] as string }, { device_id: row["device_id"] });
      }
      return reply.code(202).send({ message_id: messageId, session_id: row["id"] });
    });

    r.get("/v1/sessions/:id/messages", async (req) => {
      const { row } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      return {
        data: await ctx.db.query(
          `SELECT m.*, u.name AS actor_name, f.rating AS my_rating FROM messages m LEFT JOIN users u ON u.id = m.actor_id
             LEFT JOIN message_feedback f ON f.message_id = m.id AND f.user_id = $2 WHERE m.session_id = $1 ORDER BY m.started_at`,
          [row["id"], req.auth.userId],
        ),
      };
    });

    r.post("/v1/sessions/:id/interrupt", async (req) => {
      const { row, permission } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      needControl(permission);
      if (!row["device_id"]) throw conflict("this session's device was removed", "device_removed");
      return ctx.hub.call(row["device_id"] as string, "session.interrupt", { session_id: row["id"] as string }, { user_id: req.auth.userId, name: req.auth.name });
    });

    r.post("/v1/sessions/:id/actions", async (req) => {
      const { row, permission } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      needControl(permission);
      if (!row["device_id"]) throw conflict("this session's device was removed", "device_removed");
      const action = parse(SubmitAction, req.body);
      await audit(ctx.db, req.auth, "session.action", { type: "session", id: row["id"] as string }, { decision: action.decision });
      return ctx.hub.call(row["device_id"] as string, "session.action", { session_id: row["id"] as string, action }, { user_id: req.auth.userId, name: req.auth.name });
    });

    /**
     * Fork: a new session that starts from this one's conversation so far and
     * then goes its own way. The source is never changed.
     */
    r.post("/v1/sessions/:id/fork", async (req, reply) => {
      const { row, permission } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      needControl(permission);
      if (row["runtime_provider"] === "codex") throw badRequest("the Codex runtime cannot fork a thread", "fork_unsupported");
      if (row["status"] === "running") throw conflict("wait for the running turn to finish before forking", "session_busy");
      if (!row["runtime_session_id"]) throw conflict("this session has no conversation to fork yet", "nothing_to_fork");
      if (!row["device_id"]) throw conflict("this session's device was removed", "device_removed");
      await requirePermission(ctx.db, req.auth, "device", row["device_id"] as string, "use");
      const { title } = parse(z.object({ title: z.string().max(256).optional() }), req.body);
      const id = crypto.randomUUID();
      const metadata = { ...(row["metadata"] as Row), valuz: { fork: { session_id: row["id"], native_session_id: row["runtime_session_id"] } } };
      const fork = await ctx.db.tx(async (tx) => {
        const created = await tx.one(
          `INSERT INTO sessions (id, org_id, owner_id, device_id, project_id, agent_id, provider_id, title, runtime_provider, model, cwd,
                                 agent_config, model_settings, instructions, permission_mode, mode, metadata, status, todos)
           SELECT $1, org_id, $2, device_id, project_id, agent_id, provider_id, $3, runtime_provider, model, cwd,
                  agent_config, model_settings, instructions, permission_mode, mode, $4, 'idle', todos FROM sessions WHERE id = $5 RETURNING *`,
          [id, req.auth.userId, title || `${String(row["title"] || (row["agent_config"] as Row)["name"])}（分叉）`, json(metadata), row["id"]],
        );
        // Carry the transcript over so the fork shows what it was branched from.
        await tx.query(
          `WITH map AS (SELECT id AS old_id, gen_random_uuid() AS new_id FROM messages WHERE session_id = $1 AND status <> 'running'),
                copied AS (
                  INSERT INTO messages (id, session_id, actor_id, user_message, status, assistant_message, error_message, stop_reason, total_turns, input_tokens,
                                        output_tokens, cache_read_tokens, cache_write_tokens, model_usage, metadata, todos, started_at, ended_at)
                  SELECT map.new_id, $2, m.actor_id, m.user_message, m.status, m.assistant_message, m.error_message, m.stop_reason, m.total_turns, m.input_tokens,
                         m.output_tokens, m.cache_read_tokens, m.cache_write_tokens, m.model_usage, m.metadata, m.todos, m.started_at, m.ended_at
                    FROM messages m JOIN map ON map.old_id = m.id RETURNING id)
           INSERT INTO events (session_id, message_id, type, data, ts, event_uid)
           SELECT $2, map.new_id, e.type, e.data, e.ts, gen_random_uuid() FROM events e JOIN map ON map.old_id = e.message_id
            WHERE e.session_id = $1 ORDER BY e.seq`,
          [row["id"], id],
        );
        return created;
      });
      await audit(ctx.db, req.auth, "session.fork", { type: "session", id }, { source: row["id"] });
      return reply.code(201).send({ ...fork, permission: "admin" });
    });

    // -- Queue: messages typed while a turn is running --
    r.get("/v1/sessions/:id/queue", async (req) => {
      const { row } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      return {
        data: await ctx.db.query(
          "SELECT q.id, q.text, q.actor_id, u.name AS actor_name, q.created_at FROM queued_inputs q JOIN users u ON u.id = q.actor_id WHERE q.session_id = $1 ORDER BY q.created_at, q.id",
          [row["id"]],
        ),
      };
    });

    r.post("/v1/sessions/:id/queue", async (req, reply) => {
      const { row, permission } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      needControl(permission);
      const { text } = parse(z.object({ text: z.string().min(1).max(1_000_000) }), req.body);
      const id = crypto.randomUUID();
      await ctx.db.query("INSERT INTO queued_inputs (id, session_id, actor_id, text) VALUES ($1, $2, $3, $4)", [id, row["id"], req.auth.userId, text]);
      // If the turn ended while this was being typed, there is nothing to wait for.
      const sent = await drainQueue(ctx, row["id"] as string);
      return reply.code(201).send({ id, sent });
    });

    r.delete("/v1/sessions/:id/queue/:queueId", async (req, reply) => {
      const { row, permission } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      needControl(permission);
      await ctx.db.query("DELETE FROM queued_inputs WHERE id = $1 AND session_id = $2", [uuidParam((req.params as Params)["queueId"], "queued message"), row["id"]]);
      return reply.code(204).send();
    });

    /** Start the queue again after an error or interrupt left it waiting. */
    r.post("/v1/sessions/:id/queue/resume", async (req) => {
      const { row, permission } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      needControl(permission);
      return { sent: await drainQueue(ctx, row["id"] as string) };
    });

    // -- Feedback on a turn --
    r.put("/v1/sessions/:id/feedback", async (req) => {
      const { row } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      const body = parse(z.object({ message_id: z.string().uuid(), rating: z.enum(["up", "down"]).nullable(), comment: z.string().max(4000).default("") }), req.body);
      const message = await ctx.db.one("SELECT 1 FROM messages WHERE id = $1 AND session_id = $2", [body.message_id, row["id"]]);
      if (!message) throw notFound("message");
      if (body.rating === null) {
        await ctx.db.query("DELETE FROM message_feedback WHERE message_id = $1 AND user_id = $2", [body.message_id, req.auth.userId]);
      } else {
        await ctx.db.query(
          `INSERT INTO message_feedback (message_id, user_id, rating, comment) VALUES ($1, $2, $3, $4)
           ON CONFLICT (message_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, created_at = now()`,
          [body.message_id, req.auth.userId, body.rating, body.comment],
        );
      }
      return { message_id: body.message_id, rating: body.rating };
    });

    // -- Events --
    r.get("/v1/sessions/:id/events", async (req) => {
      const { row } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      const q = parse(z.object({ after_seq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(200) }), req.query);
      const data = await eventsAfter(row["id"] as string, q.after_seq, q.limit);
      return { data, next_seq: data.at(-1)?.seq ?? q.after_seq };
    });

    r.get("/v1/sessions/:id/events/stream", async (req, reply) => {
      const { row } = await sessionAccess(ctx, req.auth, (req.params as Params)["id"] ?? "");
      const id = row["id"] as string;
      await streamEvents(ctx, req, reply, sessionChannel(id), (after) => eventsAfter(id, after, 500));
    });

    /** Org activity: device presence and session status changes, live only. */
    r.get("/v1/stream", async (req, reply) => {
      await streamEvents(ctx, req, reply, orgChannel(req.auth.orgId), null);
    });

    shareRoutes(r, ctx, "/v1/sessions/:key", "session", async (auth, id) => {
      const { row, permission } = await sessionAccess(ctx, auth, id);
      if (permission !== "admin") throw new HttpError(403, "forbidden", "only the session owner or an org admin can share it");
      return row["id"] as string;
    });
  });
}
