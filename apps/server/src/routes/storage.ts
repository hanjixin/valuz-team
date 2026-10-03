/** Cloud storage configuration (per organization) and shared files. */
import { permissionAtLeast } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aclParams, audit, permissionSql } from "../acl.ts";
import { withAuth } from "../auth.ts";
import { type Auth, type Ctx, isOrgAdmin } from "../context.ts";
import type { Row } from "../db.ts";
import { HttpError, badRequest, forbidden, notFound, parse, uuidParam } from "../http.ts";
import type { FileRef, StorageTarget } from "../storage.ts";
import { shareRoutes } from "./shares.ts";

const StorageConfig = z.discriminatedUnion("driver", [
  z.object({ driver: z.literal("local") }),
  z.object({
    driver: z.literal("s3"),
    /** Leave empty for AWS; set for COS / OSS / MinIO / R2. */
    endpoint: z.string().url().nullable().default(null),
    region: z.string().min(1).default("us-east-1"),
    bucket: z.string().min(1),
    prefix: z.string().max(256).default(""),
    access_key_id: z.string().min(1),
    /** Omit on update to keep the stored secret. */
    secret_access_key: z.string().min(1).optional(),
    force_path_style: z.boolean().default(false),
  }),
]);

const CreateFile = z.object({
  name: z.string().min(1).max(512),
  content_type: z.string().max(255).default("application/octet-stream"),
  project_id: z.string().uuid().nullable().default(null),
});

type Params = Record<string, string>;
const asRef = (row: Row): FileRef => row as unknown as FileRef;

export function storageRoutes(app: FastifyInstance, ctx: Ctx): void {
  const findFile = async (auth: Auth, id: string): Promise<Row> => {
    const row = await ctx.db.one(
      `SELECT * FROM (SELECT r.*, ${permissionSql("file")} AS permission FROM files r WHERE r.org_id = $2::uuid AND r.id = $4) x WHERE permission IS NOT NULL`,
      [...aclParams(auth), uuidParam(id, "file")],
    );
    if (!row) throw notFound("file");
    return row;
  };

  // Local-driver transfers are authorized by the signed link, not a session.
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
  app.put("/v1/files/:id/content", async (req, reply) => {
    const id = uuidParam((req.params as Params)["id"], "file");
    const q = req.query as Record<string, string>;
    ctx.storage.verifyLocalUrl(id, "put", q["exp"] ?? "", q["sig"] ?? "");
    const file = await ctx.db.one("SELECT * FROM files WHERE id = $1 AND driver = 'local'", [id]);
    if (!file) throw notFound("file");
    await ctx.storage.writeLocal(asRef(file), req.raw);
    return reply.code(204).send();
  });

  app.get("/v1/files/:id/content", async (req, reply) => {
    const id = uuidParam((req.params as Params)["id"], "file");
    const q = req.query as Record<string, string>;
    ctx.storage.verifyLocalUrl(id, "get", q["exp"] ?? "", q["sig"] ?? "");
    const file = await ctx.db.one("SELECT * FROM files WHERE id = $1 AND driver = 'local' AND status = 'ready'", [id]);
    if (!file) throw notFound("file");
    return reply
      .header("content-type", file["content_type"])
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(String(file["name"]))}`)
      .send(ctx.storage.readLocal(asRef(file)));
  });

  withAuth(app, ctx, (r) => {
    r.get("/v1/storage/config", async (req) => {
      const row = await ctx.db.one("SELECT driver, endpoint, region, bucket, prefix, access_key_id, force_path_style, updated_at FROM storage_configs WHERE org_id = $1", [req.auth.orgId]);
      return row ?? { driver: "local" };
    });

    r.put("/v1/storage/config", async (req) => {
      if (!isOrgAdmin(req.auth)) throw forbidden("only organization owners and admins can configure storage");
      const body = parse(StorageConfig, req.body);
      if (body.driver === "local") {
        await ctx.db.query(
          `INSERT INTO storage_configs (org_id, driver, updated_by) VALUES ($1, 'local', $2)
           ON CONFLICT (org_id) DO UPDATE SET driver = 'local', endpoint = NULL, bucket = NULL, access_key_id = NULL, secret_enc = NULL, updated_by = $2, updated_at = now()`,
          [req.auth.orgId, req.auth.userId],
        );
        await audit(ctx.db, req.auth, "storage.configure", {}, { driver: "local" });
        return { driver: "local" };
      }
      let secret = body.secret_access_key;
      if (!secret) {
        const prior = await ctx.db.one<{ secret_enc: string | null }>("SELECT secret_enc FROM storage_configs WHERE org_id = $1", [req.auth.orgId]);
        if (!prior?.secret_enc) throw badRequest("secret_access_key is required");
        secret = ctx.box.open("storage", prior.secret_enc);
      }
      const target: StorageTarget = {
        driver: "s3", endpoint: body.endpoint, region: body.region, bucket: body.bucket, prefix: body.prefix,
        accessKeyId: body.access_key_id, secretAccessKey: secret, forcePathStyle: body.force_path_style,
      };
      // Never save a bucket the server cannot actually write to.
      try {
        await ctx.storage.test(target);
      } catch (err) {
        throw new HttpError(422, "storage_unreachable", `could not write to the bucket: ${(err as Error).message}`);
      }
      await ctx.db.query(
        `INSERT INTO storage_configs (org_id, driver, endpoint, region, bucket, prefix, access_key_id, secret_enc, force_path_style, updated_by)
         VALUES ($1, 's3', $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (org_id) DO UPDATE SET driver = 's3', endpoint = $2, region = $3, bucket = $4, prefix = $5, access_key_id = $6,
           secret_enc = $7, force_path_style = $8, updated_by = $9, updated_at = now()`,
        [req.auth.orgId, body.endpoint, body.region, body.bucket, body.prefix, body.access_key_id, ctx.box.seal("storage", secret), body.force_path_style, req.auth.userId],
      );
      await audit(ctx.db, req.auth, "storage.configure", {}, { driver: "s3", bucket: body.bucket, endpoint: body.endpoint });
      const { secret_access_key: _omit, ...saved } = body;
      return saved;
    });

    // -- Files: create → upload to the returned URL → complete --
    r.post("/v1/files", async (req, reply) => {
      const body = parse(CreateFile, req.body);
      const target = await ctx.storage.resolve(req.auth.orgId);
      const id = crypto.randomUUID();
      const row = await ctx.db.one(
        `INSERT INTO files (id, org_id, owner_id, project_id, name, content_type, driver, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [id, req.auth.orgId, req.auth.userId, body.project_id, body.name, body.content_type, target.driver, ctx.storage.newKey(target, req.auth.orgId, id, body.name)],
      );
      return reply.code(201).send({ file: { ...row, permission: "admin" }, upload: await ctx.storage.uploadUrl(asRef(row as Row)) });
    });

    r.post("/v1/files/:id/complete", async (req) => {
      const file = await findFile(req.auth, (req.params as Params)["id"] ?? "");
      if (file["owner_id"] !== req.auth.userId) throw forbidden("only the uploader can complete an upload");
      const size = await ctx.storage.size(asRef(file));
      if (size === null) throw new HttpError(409, "not_uploaded", "no content has been uploaded for this file yet");
      const row = await ctx.db.one("UPDATE files SET status = 'ready', size = $2 WHERE id = $1 RETURNING *", [file["id"], size]);
      return { ...row, permission: file["permission"] };
    });

    r.get("/v1/files", async (req) => ({
      data: await ctx.db.query(
        `SELECT * FROM (SELECT r.*, ${permissionSql("file")} AS permission FROM files r WHERE r.org_id = $2::uuid AND r.status = 'ready') x
          WHERE permission IS NOT NULL ORDER BY created_at DESC LIMIT 200`,
        aclParams(req.auth),
      ),
    }));

    r.get("/v1/files/:id/download", async (req) => {
      const file = await findFile(req.auth, (req.params as Params)["id"] ?? "");
      if (file["status"] !== "ready") throw new HttpError(409, "not_uploaded", "this file has not finished uploading");
      return { url: await ctx.storage.downloadUrl(asRef(file)), name: file["name"], size: file["size"] };
    });

    r.delete("/v1/files/:id", async (req, reply) => {
      const file = await findFile(req.auth, (req.params as Params)["id"] ?? "");
      if (!permissionAtLeast(file["permission"] as never, "admin")) throw forbidden("only the owner or an org admin can delete this file");
      await ctx.storage.remove(asRef(file)).catch(() => undefined);
      await ctx.db.tx(async (tx) => {
        await tx.query("DELETE FROM resource_shares WHERE resource_type = 'file' AND resource_id = $1", [file["id"]]);
        await tx.query("DELETE FROM files WHERE id = $1", [file["id"]]);
      });
      return reply.code(204).send();
    });

    shareRoutes(r, ctx, "/v1/files/:key", "file", async (auth, id) => (await findFile(auth, id))["id"] as string);
  });
}
