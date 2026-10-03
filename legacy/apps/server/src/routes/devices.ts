/**
 * Devices — register a desktop host, link it, share it, and control it
 * remotely. Remote control (files, commands) needs `control` on the device and
 * every call is written to the audit log.
 */
import { DEVICE_LINK_PATH, type RpcMethod, type RpcParams, permissionAtLeast } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aclParams, audit, permissionSql } from "../acl.ts";
import { withAuth } from "../auth.ts";
import type { Auth, Ctx } from "../context.ts";
import { hashToken, newToken } from "../crypto.ts";
import type { Row } from "../db.ts";
import { forbidden, notFound, parse, unauthorized, uuidParam } from "../http.ts";
import { orgChannel } from "../device-hub.ts";
import { shareRoutes } from "./shares.ts";

type Params = Record<string, string>;

export function deviceRoutes(app: FastifyInstance, ctx: Ctx): void {
  const find = async (auth: Auth, id: string): Promise<Row> => {
    const row = await ctx.db.one(
      `SELECT * FROM (SELECT r.id, r.org_id, r.owner_id, r.name, r.info, r.last_seen_at, r.created_at, u.name AS owner_name,
                             ${permissionSql("device")} AS permission
                        FROM devices r JOIN users u ON u.id = r.owner_id
                       WHERE r.org_id = $2::uuid AND r.id = $4 AND r.revoked_at IS NULL) x WHERE permission IS NOT NULL`,
      [...aclParams(auth), uuidParam(id, "device")],
    );
    if (!row) throw notFound("device");
    return row;
  };

  // The link itself authenticates with the device token, not a user token.
  // It is checked before the upgrade, so the socket handler stays synchronous:
  // a host sends its hello the instant the socket opens, and a listener
  // attached after an await would miss it.
  const linked = new WeakMap<object, { id: string; org_id: string }>();
  app.get(
    DEVICE_LINK_PATH,
    {
      websocket: true,
      preValidation: async (req) => {
        const header = req.headers.authorization;
        const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
        const device = token
          ? await ctx.db.one<{ id: string; org_id: string }>("SELECT id, org_id FROM devices WHERE token_hash = $1 AND revoked_at IS NULL", [hashToken(token)])
          : null;
        if (!device) throw unauthorized("invalid or revoked device token");
        linked.set(req.raw, device);
      },
    },
    (socket, req) => {
      const device = linked.get(req.raw);
      if (!device) return socket.close(4401, "invalid device token");
      ctx.hub.attach(device.id, device.org_id, socket);
    },
  );

  withAuth(app, ctx, (r) => {
    r.post("/v1/devices", async (req, reply) => {
      const { name } = parse(z.object({ name: z.string().min(1).max(128) }), req.body);
      const id = crypto.randomUUID();
      const token = newToken("dev");
      await ctx.db.query("INSERT INTO devices (id, org_id, owner_id, name, token_hash) VALUES ($1, $2, $3, $4, $5)", [
        id, req.auth.orgId, req.auth.userId, name, hashToken(token),
      ]);
      await audit(ctx.db, req.auth, "device.register", { type: "device", id }, { name });
      // The device token is shown exactly once.
      return reply.code(201).send({ id, name, token, owner_id: req.auth.userId, link_path: DEVICE_LINK_PATH });
    });

    r.get("/v1/devices", async (req) => {
      const rows = await ctx.db.query(
        `SELECT * FROM (SELECT r.id, r.owner_id, r.name, r.info, r.last_seen_at, r.created_at, u.name AS owner_name,
                               ${permissionSql("device")} AS permission
                          FROM devices r JOIN users u ON u.id = r.owner_id
                         WHERE r.org_id = $2::uuid AND r.revoked_at IS NULL) x WHERE permission IS NOT NULL ORDER BY created_at DESC`,
        aclParams(req.auth),
      );
      const online = await ctx.hub.onlineSet(rows.map((d) => d["id"] as string));
      return { data: rows.map((d) => ({ ...d, online: online.has(d["id"] as string) })) };
    });

    r.get("/v1/devices/:id", async (req) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "");
      return { ...row, online: await ctx.hub.isOnline(row["id"] as string) };
    });

    r.patch("/v1/devices/:id", async (req) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "");
      if (row["permission"] !== "admin") throw forbidden("only the device owner or an org admin can rename it");
      const { name } = parse(z.object({ name: z.string().min(1).max(128) }), req.body);
      await ctx.db.query("UPDATE devices SET name = $2 WHERE id = $1", [row["id"], name]);
      return { ...row, name };
    });

    /** Revoke: the token stops working and the live link is dropped. */
    r.delete("/v1/devices/:id", async (req, reply) => {
      const row = await find(req.auth, (req.params as Params)["id"] ?? "");
      if (row["permission"] !== "admin") throw forbidden("only the device owner or an org admin can revoke it");
      await ctx.db.tx(async (tx) => {
        await tx.query("UPDATE devices SET revoked_at = now() WHERE id = $1", [row["id"]]);
        await tx.query("DELETE FROM resource_shares WHERE resource_type = 'device' AND resource_id = $1", [row["id"]]);
      });
      await ctx.pubsub.publish(orgChannel(req.auth.orgId), { type: "device.revoked", device_id: row["id"] });
      await ctx.hub.drop(row["id"] as string);
      await audit(ctx.db, req.auth, "device.revoke", { type: "device", id: row["id"] as string });
      return reply.code(204).send();
    });

    shareRoutes(r, ctx, "/v1/devices/:key", "device", async (auth, id) => (await find(auth, id))["id"] as string);

    // -- Remote control --
    const remote = <M extends RpcMethod>(path: string, method: M, schema: z.ZodTypeAny, timeoutMs = 30_000) => {
      r.post(`/v1/devices/:id/${path}`, async (req) => {
        const row = await find(req.auth, (req.params as Params)["id"] ?? "");
        if (!permissionAtLeast(row["permission"] as never, "control")) {
          throw forbidden('remote control needs "control" permission on the device');
        }
        const params = parse(schema, req.body) as RpcParams<M>;
        const logged = { ...(params as Row) };
        if ("content" in logged) logged["content"] = `<${String(logged["content"]).length} chars>`;
        await audit(ctx.db, req.auth, `device.${method}`, { type: "device", id: row["id"] as string }, logged);
        const extra = "timeout_ms" in (params as Row) ? Number((params as Row)["timeout_ms"]) : 0;
        return ctx.hub.call(row["id"] as string, method, params, { user_id: req.auth.userId, name: req.auth.name }, timeoutMs + extra);
      });
    };
    const Path = z.object({ path: z.string().min(1).max(4096) });
    remote("fs/list", "fs.list", Path);
    remote("fs/stat", "fs.stat", Path);
    remote("fs/read", "fs.read", Path.extend({ max_bytes: z.number().int().min(1).max(8_388_608).default(1_048_576) }));
    remote("fs/write", "fs.write", Path.extend({ content: z.string().max(8_388_608), encoding: z.enum(["utf8", "base64"]).default("utf8") }));
    remote("fs/mkdir", "fs.mkdir", Path);
    remote("exec", "exec.run", z.object({ command: z.string().min(1).max(8192), cwd: z.string().min(1), timeout_ms: z.number().int().min(1000).max(600_000).default(60_000) }));
    remote("info", "device.info", z.object({}));
  });
}
