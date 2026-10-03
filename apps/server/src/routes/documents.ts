/** Knowledge base documents and notifications. */
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, requirePermission } from "../acl.ts";
import { withAuth } from "../auth.ts";
import { type Auth, type Ctx, isOrgAdmin } from "../context.ts";
import { SUPPORTED_EXTENSIONS } from "../documents.ts";
import type { Row } from "../db.ts";
import { badRequest, forbidden, notFound, parse, uuidParam } from "../http.ts";
import { mountToolkit } from "../mcp.ts";
import { streamEvents } from "./sessions.ts";

type Params = Record<string, string>;
export const userChannel = (userId: string, orgId: string): string => `user:${userId}:${orgId}`;

export function documentRoutes(app: FastifyInstance, ctx: Ctx): void {
  mountToolkit(app, ctx, ctx.documents.toolkit());

  /** Project documents follow the project; the org library is readable by every member. */
  const find = async (auth: Auth, id: string, write: boolean): Promise<Row> => {
    const doc = await ctx.db.one(
      "SELECT id, org_id, owner_id, project_id, file_id, title, filename, status, error, text_chars, chunk_count, created_at, updated_at FROM documents WHERE id = $1 AND org_id = $2",
      [uuidParam(id, "document"), auth.orgId],
    );
    if (!doc) throw notFound("document");
    if (doc["project_id"]) await requirePermission(ctx.db, auth, "project", doc["project_id"] as string, write ? "edit" : "view");
    else if (write && doc["owner_id"] !== auth.userId && !isOrgAdmin(auth)) throw forbidden("only the uploader or an org admin can change a library document");
    return doc;
  };

  withAuth(app, ctx, (r) => {
    r.post("/v1/documents", async (req, reply) => {
      const body = parse(z.object({ file_id: z.string().uuid(), project_id: z.string().uuid().nullable().default(null), title: z.string().max(512).optional() }), req.body);
      if (body.project_id) await requirePermission(ctx.db, req.auth, "project", body.project_id, "edit");
      const file = await ctx.db.one("SELECT * FROM files WHERE id = $1 AND org_id = $2 AND owner_id = $3 AND status = 'ready'", [body.file_id, req.auth.orgId, req.auth.userId]);
      if (!file) throw notFound("uploaded file");
      const ext = path.extname(file["name"] as string).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        throw badRequest(`"${ext || String(file["name"])}" cannot be added to the knowledge base (supported: ${SUPPORTED_EXTENSIONS.join(" ")})`, "unsupported_type");
      }
      const id = crypto.randomUUID();
      const doc = await ctx.db.one(
        "INSERT INTO documents (id, org_id, owner_id, project_id, file_id, title, filename) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, project_id, title, filename, status, created_at",
        [id, req.auth.orgId, req.auth.userId, body.project_id, body.file_id, body.title || path.basename(file["name"] as string, ext), file["name"]],
      );
      await ctx.documents.enqueue(id);
      await audit(ctx.db, req.auth, "document.add", { type: "document", id }, { project_id: body.project_id });
      return reply.code(201).send(doc);
    });

    r.get("/v1/documents", async (req) => {
      const q = parse(z.object({ project_id: z.string().uuid().optional() }), req.query);
      if (q.project_id) await requirePermission(ctx.db, req.auth, "project", q.project_id, "view");
      // With a project: its documents and the library. Without: the library alone.
      return {
        data: await ctx.db.query(
          `SELECT d.id, d.project_id, d.owner_id, d.title, d.filename, d.status, d.error, d.text_chars, d.chunk_count, d.created_at, u.name AS owner_name
             FROM documents d JOIN users u ON u.id = d.owner_id
            WHERE d.org_id = $1 AND (d.project_id IS NULL OR d.project_id = $2::uuid) ORDER BY d.created_at DESC`,
          [req.auth.orgId, q.project_id ?? null],
        ),
      };
    });

    r.get("/v1/documents/search", async (req) => {
      const q = parse(z.object({ q: z.string().min(1).max(500), project_id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(20).default(8) }), req.query);
      if (q.project_id) await requirePermission(ctx.db, req.auth, "project", q.project_id, "view");
      return { data: await ctx.documents.search({ orgId: req.auth.orgId, projectId: q.project_id ?? null }, q.q, q.limit) };
    });

    r.get("/v1/documents/:id", async (req) => {
      const doc = await find(req.auth, (req.params as Params)["id"] ?? "", false);
      const q = parse(z.object({ offset: z.coerce.number().int().min(0).default(0) }), req.query);
      const preview = doc["status"] === "ready"
        ? await ctx.documents.read({ orgId: req.auth.orgId, projectId: (doc["project_id"] as string | null) ?? null }, doc["id"] as string, q.offset, 20_000)
        : null;
      return { ...doc, preview };
    });

    r.post("/v1/documents/:id/reindex", async (req, reply) => {
      const doc = await find(req.auth, (req.params as Params)["id"] ?? "", true);
      await ctx.documents.enqueue(doc["id"] as string);
      return reply.code(202).send({ queued: true });
    });

    r.delete("/v1/documents/:id", async (req, reply) => {
      const doc = await find(req.auth, (req.params as Params)["id"] ?? "", true);
      await ctx.db.query("DELETE FROM documents WHERE id = $1", [doc["id"]]);
      await audit(ctx.db, req.auth, "document.delete", { type: "document", id: doc["id"] as string });
      return reply.code(204).send();
    });

    // -- Notifications (per person, per organization) --
    r.get("/v1/notifications", async (req) => {
      const rows = await ctx.db.query(
        "SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE user_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 100",
        [req.auth.userId, req.auth.orgId],
      );
      return { data: rows, unread: rows.filter((n) => n["read_at"] === null).length };
    });

    r.post("/v1/notifications/read-all", async (req) => {
      await ctx.db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND org_id = $2 AND read_at IS NULL", [req.auth.userId, req.auth.orgId]);
      return { unread: 0 };
    });

    r.post("/v1/notifications/:id/read", async (req) => {
      const row = await ctx.db.one("UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id", [
        uuidParam((req.params as Params)["id"], "notification"), req.auth.userId,
      ]);
      if (!row) throw notFound("notification");
      return { read: true };
    });

    r.delete("/v1/notifications/:id", async (req, reply) => {
      await ctx.db.query("DELETE FROM notifications WHERE id = $1 AND user_id = $2", [uuidParam((req.params as Params)["id"], "notification"), req.auth.userId]);
      return reply.code(204).send();
    });

    /** Live notifications for the signed-in person. */
    r.get("/v1/notifications/stream", async (req, reply) => {
      await streamEvents(ctx, req, reply, userChannel(req.auth.userId, req.auth.orgId), null);
    });
  });
}

export interface Notice {
  kind: string;
  title: string;
  body?: string;
  link?: string;
}

/** Store a notification and push it to the person's open clients. */
export async function notify(ctx: Ctx, userId: string, orgId: string, notice: Notice): Promise<void> {
  const row = await ctx.db.one(
    "INSERT INTO notifications (id, org_id, user_id, kind, title, body, link) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, kind, title, body, link, read_at, created_at",
    [crypto.randomUUID(), orgId, userId, notice.kind, notice.title, notice.body ?? "", notice.link ?? null],
  );
  await ctx.pubsub.publish(userChannel(userId, orgId), { type: "notification", ...row });
}

