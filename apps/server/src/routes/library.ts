/**
 * The shared resource library: model providers, skills, connectors, agents.
 * All four follow one shape — owned by a member, private by default, shared
 * through the ladder — so they are generated from a spec.
 */
import {
  ApiProtocol,
  EffortLevel,
  McpServerConfig,
  PermissionMode,
  type ResourceType,
  RuntimeProvider,
  permissionAtLeast,
} from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aclParams, audit, permissionSql, requirePermission } from "../acl.ts";
import { withAuth } from "../auth.ts";
import type { Auth, Ctx } from "../context.ts";
import { type Row, json } from "../db.ts";
import { badRequest, conflict, forbidden, isUuid, notFound, parse, slugify } from "../http.ts";
import { shareRoutes } from "./shares.ts";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/, "use lowercase letters, digits, '.', '_' or '-'");

interface Spec {
  type: ResourceType;
  table: string;
  path: string;
  /** Addressed by slug (agents/skills/connectors) or by id (providers). */
  keyed: "slug" | "id";
  create: z.ZodTypeAny;
  update: z.ZodTypeAny;
  jsonColumns: string[];
  /** Plaintext body field → sealed into `secret_enc` under this purpose. */
  secret?: { field: string; purpose: string; encode: (value: unknown) => string };
  /** Runs after a successful create or update, with the stored row. */
  after?: (ctx: Ctx, auth: Auth, row: Row, existing: Row | null) => Promise<void>;
  /** Cross-field checks and derived columns, run before a write. */
  prepare?: (ctx: Ctx, auth: Auth, values: Row, existing: Row | null) => Promise<void>;
}

const present = (row: Row): Row => {
  const { secret_enc, ...rest } = row;
  return "secret_enc" in row ? { ...rest, has_secret: secret_enc != null } : rest;
};

function resourceRoutes(app: FastifyInstance, ctx: Ctx, spec: Spec): void {
  const key = spec.keyed;

  const find = async (auth: Auth, value: string): Promise<Row> => {
    if (key === "id" && !isUuid(value)) throw notFound(spec.type);
    const row = await ctx.db.one(
      `SELECT * FROM (SELECT r.*, ${permissionSql(spec.type)} AS permission FROM ${spec.table} r WHERE r.org_id = $2::uuid AND r.${key} = $4) x
        WHERE permission IS NOT NULL`,
      [...aclParams(auth), value],
    );
    if (!row) throw notFound(spec.type);
    return row;
  };

  const columnsOf = async (auth: Auth, body: Row, existing: Row | null): Promise<Row> => {
    const values: Row = { ...body };
    if (spec.secret && spec.secret.field in values) {
      const plain = values[spec.secret.field];
      delete values[spec.secret.field];
      values["secret_enc"] = plain == null ? null : ctx.box.seal(spec.secret.purpose, spec.secret.encode(plain));
    }
    await spec.prepare?.(ctx, auth, values, existing);
    for (const column of spec.jsonColumns) if (column in values) values[column] = json(values[column]);
    return values;
  };

  app.get(spec.path, async (req) => ({
    data: (
      await ctx.db.query(
        `SELECT * FROM (SELECT r.*, ${permissionSql(spec.type)} AS permission FROM ${spec.table} r WHERE r.org_id = $2::uuid) x
          WHERE permission IS NOT NULL ORDER BY created_at DESC`,
        aclParams(req.auth),
      )
    ).map(present),
  }));

  app.post(spec.path, async (req, reply) => {
    const body = parse(spec.create, req.body) as Row;
    if (key === "slug") {
      body["slug"] ??= slugify(String(body["name"]));
      const dup = await ctx.db.one(`SELECT 1 FROM ${spec.table} WHERE org_id = $1 AND slug = $2`, [req.auth.orgId, body["slug"]]);
      if (dup) throw conflict(`a ${spec.type} with slug "${String(body["slug"])}" already exists`, "slug_taken");
    }
    const values = await columnsOf(req.auth, body, null);
    const row: Row = { id: crypto.randomUUID(), org_id: req.auth.orgId, owner_id: req.auth.userId, ...values };
    const names = Object.keys(row);
    const created = await ctx.db.one(
      `INSERT INTO ${spec.table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      Object.values(row),
    );
    await spec.after?.(ctx, req.auth, created as Row, null);
    await audit(ctx.db, req.auth, `${spec.type}.create`, { type: spec.type, id: row["id"] as string });
    return reply.code(201).send(present({ ...created, permission: "admin" }));
  });

  app.get(`${spec.path}/:key`, async (req) => present(await find(req.auth, (req.params as Row)["key"] as string)));

  app.patch(`${spec.path}/:key`, async (req) => {
    const existing = await find(req.auth, (req.params as Row)["key"] as string);
    if (!permissionAtLeast(existing["permission"] as never, "edit")) throw forbidden(`this needs "edit" permission on the ${spec.type}`);
    const values = await columnsOf(req.auth, parse(spec.update, req.body) as Row, existing);
    const names = Object.keys(values);
    if (names.length === 0) return present(existing);
    const updated = await ctx.db.one(
      `UPDATE ${spec.table} SET ${names.map((n, i) => `${n} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
      [existing["id"], ...Object.values(values)],
    );
    await spec.after?.(ctx, req.auth, updated as Row, existing);
    await audit(ctx.db, req.auth, `${spec.type}.update`, { type: spec.type, id: existing["id"] as string }, { fields: names });
    return present({ ...updated, permission: existing["permission"] });
  });

  app.delete(`${spec.path}/:key`, async (req, reply) => {
    const existing = await find(req.auth, (req.params as Row)["key"] as string);
    if (existing["permission"] !== "admin") throw forbidden(`only the owner or an org admin can delete this ${spec.type}`);
    await ctx.db.tx(async (tx) => {
      await tx.query("DELETE FROM resource_shares WHERE resource_type = $1 AND resource_id = $2", [spec.type, existing["id"]]);
      await tx.query(`DELETE FROM ${spec.table} WHERE id = $1`, [existing["id"]]);
    });
    await audit(ctx.db, req.auth, `${spec.type}.delete`, { type: spec.type, id: existing["id"] as string });
    return reply.code(204).send();
  });

  shareRoutes(app, ctx, `${spec.path}/:key`, spec.type, async (auth, value) => (await find(auth, value))["id"] as string);
}

// -- Providers --
const ProviderCreate = z.object({
  name: z.string().min(1).max(128),
  provider_kind: z.string().max(64).default("custom"),
  protocol: ApiProtocol,
  base_url: z.string().url().nullable().default(null),
  default_model: z.string().max(128).nullable().default(null),
  model_ids: z.array(z.string()).default([]),
  api_key: z.string().min(1).nullable().default(null),
  enabled: z.boolean().default(true),
});

// -- Skills --
const SkillFile = z.object({ path: z.string().min(1).max(512), content: z.string().max(1_000_000) });
const SkillFiles = z
  .array(SkillFile)
  .max(200)
  .refine((files) => files.some((f) => f.path === "SKILL.md"), "a skill must contain SKILL.md")
  .refine((files) => files.every((f) => !f.path.startsWith("/") && !f.path.split("/").includes("..")), "skill paths must stay inside the bundle");
const SkillCreate = z.object({
  slug: Slug.optional(),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).default(""),
  files: SkillFiles,
});

// -- Connectors (MCP servers) --
const ConnectorCreate = z.object({
  slug: Slug.optional(),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).default(""),
  /** MCP server definition; `name` is filled from the slug at dispatch. */
  config: z.record(z.unknown()),
  /** Credential headers (http/sse) or env vars (stdio) — stored encrypted, never returned. */
  secrets: z.record(z.string()).nullable().default(null),
  enabled: z.boolean().default(true),
});

// -- Agent packs --
const PACK_FORMAT = "agent-base.pack/v1";
const Pack = z.object({
  format: z.literal(PACK_FORMAT),
  agents: z.array(z.object({
    slug: Slug, name: z.string().min(1).max(256), description: z.string().max(2000).default(""), avatar: z.string().max(128).nullable().default(null),
    instructions: z.string().max(200_000).default(""), runtime: RuntimeProvider, model: z.string().max(128).default(""), effort: EffortLevel.nullable().default(null),
    permission_mode: PermissionMode.default("full_access"), skills: z.array(Slug).default([]), connectors: z.array(Slug).default([]),
  })).max(50),
  skills: z.array(z.object({ slug: Slug, name: z.string().min(1).max(128), description: z.string().max(2000).default(""), files: SkillFiles })).max(200).default([]),
  connectors: z.array(z.object({ slug: Slug, name: z.string().min(1).max(128), description: z.string().max(2000).default(""), config: z.record(z.unknown()), needs_secret: z.boolean().default(false) })).max(200).default([]),
});

// -- Agents --
const AgentCreate = z.object({
  slug: Slug.optional(),
  name: z.string().min(1).max(256),
  description: z.string().max(2000).default(""),
  avatar: z.string().max(128).nullable().default(null),
  instructions: z.string().max(200_000).default(""),
  runtime: RuntimeProvider.default("claude_agent"),
  model: z.string().max(128).default(""),
  provider_id: z.string().uuid().nullable().default(null),
  effort: EffortLevel.nullable().default(null),
  permission_mode: PermissionMode.default("full_access"),
  skills: z.array(Slug).default([]),
  connectors: z.array(Slug).default([]),
});

/** Every referenced slug must exist and be usable by the caller. */
async function assertUsable(ctx: Ctx, auth: Auth, type: "skill" | "connector", table: string, slugs: unknown): Promise<void> {
  if (!Array.isArray(slugs) || slugs.length === 0) return;
  const rows = await ctx.db.query<{ slug: string; permission: string | null }>(
    `SELECT r.slug, ${permissionSql(type)} AS permission FROM ${table} r WHERE r.org_id = $2::uuid AND r.slug = ANY($4::text[])`,
    [...aclParams(auth), slugs],
  );
  const usable = new Set(rows.filter((r) => permissionAtLeast(r.permission as never, "use")).map((r) => r.slug));
  const missing = (slugs as string[]).filter((s) => !usable.has(s));
  if (missing.length) throw badRequest(`unknown or unshared ${type}(s): ${missing.join(", ")}`, `${type}_unavailable`);
}

export function libraryRoutes(app: FastifyInstance, ctx: Ctx): void {
  withAuth(app, ctx, (r) => {
    resourceRoutes(r, ctx, {
      type: "provider",
      table: "providers",
      path: "/v1/providers",
      keyed: "id",
      create: ProviderCreate,
      update: ProviderCreate.partial(),
      jsonColumns: ["model_ids"],
      secret: { field: "api_key", purpose: "provider", encode: String },
    });

    resourceRoutes(r, ctx, {
      type: "skill",
      table: "skills",
      path: "/v1/skills",
      keyed: "slug",
      create: SkillCreate,
      update: SkillCreate.omit({ slug: true }).partial(),
      jsonColumns: ["files"],
      prepare: async (_ctx, _auth, values, existing) => {
        // Every content change is a new version; devices re-materialize on it.
        if (existing && "files" in values) values["version"] = (existing["version"] as number) + 1;
      },
      after: async (c, auth, row, existing) => {
        if (existing && existing["version"] === row["version"]) return; // metadata-only edit
        await c.db.query(
          "INSERT INTO skill_versions (skill_id, version, name, description, files, created_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
          [row["id"], row["version"], row["name"], row["description"], json(row["files"]), auth.userId],
        );
      },
    });

    resourceRoutes(r, ctx, {
      type: "connector",
      table: "connectors",
      path: "/v1/connectors",
      keyed: "slug",
      create: ConnectorCreate,
      update: ConnectorCreate.omit({ slug: true }).partial(),
      jsonColumns: ["config"],
      secret: { field: "secrets", purpose: "connector", encode: (v) => JSON.stringify(v) },
      prepare: async (_ctx, _auth, values, existing) => {
        if (!("config" in values)) return;
        const name = String(values["slug"] ?? existing?.["slug"] ?? "connector");
        const checked = McpServerConfig.safeParse({ ...(values["config"] as object), name });
        if (!checked.success) throw badRequest(`invalid MCP server config: ${checked.error.issues[0]?.message ?? ""}`);
      },
    });

    resourceRoutes(r, ctx, {
      type: "agent",
      table: "agents",
      path: "/v1/agents",
      keyed: "slug",
      create: AgentCreate,
      update: AgentCreate.omit({ slug: true }).partial(),
      jsonColumns: ["skills", "connectors"],
      prepare: async (c, auth, values) => {
        if (values["provider_id"]) await requirePermission(c.db, auth, "provider", values["provider_id"] as string, "use");
        await assertUsable(c, auth, "skill", "skills", values["skills"]);
        await assertUsable(c, auth, "connector", "connectors", values["connectors"]);
      },
    });

    // -- Skill history --
    const skillFor = async (auth: Auth, slug: string, needed: "view" | "edit"): Promise<Row> => {
      const row = await ctx.db.one(
        `SELECT * FROM (SELECT r.*, ${permissionSql("skill")} AS permission FROM skills r WHERE r.org_id = $2::uuid AND r.slug = $4) x WHERE permission IS NOT NULL`,
        [...aclParams(auth), slug],
      );
      if (!row) throw notFound("skill");
      if (!permissionAtLeast(row["permission"] as never, needed)) throw forbidden(`this needs "${needed}" permission on the skill`);
      return row;
    };

    r.get("/v1/skills/:key/versions", async (req) => {
      const skill = await skillFor(req.auth, (req.params as Row)["key"] as string, "view");
      return {
        current: skill["version"],
        data: await ctx.db.query(
          `SELECT v.version, v.name, v.description, v.created_at, u.name AS created_by_name, jsonb_array_length(v.files) AS file_count
             FROM skill_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.skill_id = $1 ORDER BY v.version DESC`,
          [skill["id"]],
        ),
      };
    });

    r.get("/v1/skills/:key/versions/:version", async (req) => {
      const skill = await skillFor(req.auth, (req.params as Row)["key"] as string, "view");
      const version = await ctx.db.one("SELECT version, name, description, files, created_at FROM skill_versions WHERE skill_id = $1 AND version = $2", [
        skill["id"], Number((req.params as Row)["version"]) || 0,
      ]);
      if (!version) throw notFound("skill version");
      return version;
    });

    /** Restoring never rewrites history: the old content becomes a new version. */
    r.post("/v1/skills/:key/versions/:version/restore", async (req) => {
      const skill = await skillFor(req.auth, (req.params as Row)["key"] as string, "edit");
      const old = await ctx.db.one("SELECT name, description, files FROM skill_versions WHERE skill_id = $1 AND version = $2", [
        skill["id"], Number((req.params as Row)["version"]) || 0,
      ]);
      if (!old) throw notFound("skill version");
      const row = (await ctx.db.one(
        "UPDATE skills SET name = $2, description = $3, files = $4, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *",
        [skill["id"], old["name"], old["description"], json(old["files"])],
      )) as Row;
      await ctx.db.query("INSERT INTO skill_versions (skill_id, version, name, description, files, created_by) VALUES ($1, $2, $3, $4, $5, $6)", [
        row["id"], row["version"], row["name"], row["description"], json(row["files"]), req.auth.userId,
      ]);
      await audit(ctx.db, req.auth, "skill.restore", { type: "skill", id: row["id"] as string }, { from_version: (req.params as Row)["version"], new_version: row["version"] });
      return { ...row, permission: skill["permission"] };
    });

    // -- Agent packs: a portable bundle of agents with the skills and connectors they carry --
    r.post("/v1/agent-packs/export", async (req) => {
      const { agent_slugs } = parse(z.object({ agent_slugs: z.array(z.string()).min(1).max(50) }), req.body);
      const usable = (table: string, type: "agent" | "skill" | "connector", slugs: string[]) =>
        ctx.db.query(
          `SELECT * FROM (SELECT r.*, ${permissionSql(type)} AS permission FROM ${table} r WHERE r.org_id = $2::uuid AND r.slug = ANY($4::text[])) x
            WHERE permission IN ('use', 'edit', 'control', 'admin')`,
          [...aclParams(req.auth), slugs],
        );
      const agents = await usable("agents", "agent", agent_slugs);
      const missing = agent_slugs.filter((slug) => !agents.some((a) => a["slug"] === slug));
      if (missing.length) throw notFound(`agent(s) ${missing.join(", ")}`);
      const skills = await usable("skills", "skill", [...new Set(agents.flatMap((a) => a["skills"] as string[]))]);
      const connectors = await usable("connectors", "connector", [...new Set(agents.flatMap((a) => a["connectors"] as string[]))]);
      await audit(ctx.db, req.auth, "agent_pack.export", {}, { agents: agent_slugs });
      // Credentials never travel in a pack: no model channel, no connector secrets.
      return {
        format: PACK_FORMAT,
        exported_at: new Date().toISOString(),
        agents: agents.map((a) => ({
          slug: a["slug"], name: a["name"], description: a["description"], avatar: a["avatar"], instructions: a["instructions"], runtime: a["runtime"],
          model: a["model"], effort: a["effort"], permission_mode: a["permission_mode"], skills: a["skills"], connectors: a["connectors"],
        })),
        skills: skills.map((k) => ({ slug: k["slug"], name: k["name"], description: k["description"], files: k["files"] })),
        connectors: connectors.map((c) => ({ slug: c["slug"], name: c["name"], description: c["description"], config: c["config"], needs_secret: c["secret_enc"] != null })),
      };
    });

    r.post("/v1/agent-packs/import", async (req, reply) => {
      const { pack } = parse(z.object({ pack: Pack }), req.body);
      const result = { created: [] as string[], skipped: [] as string[], needs_attention: [] as string[] };
      await ctx.db.tx(async (tx) => {
        // Anything whose slug already exists here is left alone; the agents then bind to what is present.
        const add = async (kind: string, table: string, slug: string, columns: Row) => {
          const exists = await tx.one(`SELECT 1 FROM ${table} WHERE org_id = $1 AND slug = $2`, [req.auth.orgId, slug]);
          if (exists) return void result.skipped.push(`${kind}:${slug}`);
          const row: Row = { id: crypto.randomUUID(), org_id: req.auth.orgId, owner_id: req.auth.userId, slug, ...columns };
          const names = Object.keys(row);
          await tx.query(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
          if (kind === "skill") {
            await tx.query("INSERT INTO skill_versions (skill_id, version, name, description, files, created_by) VALUES ($1, 1, $2, $3, $4, $5)", [
              row["id"], columns["name"], columns["description"], columns["files"], req.auth.userId,
            ]);
          }
          result.created.push(`${kind}:${slug}`);
        };
        for (const k of pack.skills) await add("skill", "skills", k.slug, { name: k.name, description: k.description, files: json(k.files) });
        for (const c of pack.connectors) {
          await add("connector", "connectors", c.slug, { name: c.name, description: c.description, config: json(c.config) });
          if (c.needs_secret) result.needs_attention.push(`connector "${c.slug}" needs its credential set again`);
        }
        for (const a of pack.agents) {
          await add("agent", "agents", a.slug, {
            name: a.name, description: a.description, avatar: a.avatar, instructions: a.instructions, runtime: a.runtime, model: a.model, effort: a.effort,
            permission_mode: a.permission_mode, skills: json(a.skills), connectors: json(a.connectors),
          });
          if (a.runtime === "valuz_agent" || a.runtime === "deepagents") result.needs_attention.push(`agent "${a.slug}" needs a model channel before it can run`);
        }
      });
      await audit(ctx.db, req.auth, "agent_pack.import", {}, { created: result.created.length, skipped: result.skipped.length });
      return reply.code(201).send(result);
    });

    // Copying an agent makes a new agent owned by the caller (no template/instance split).
    r.post("/v1/agents/:key/copy", async (req, reply) => {
      const source = await ctx.db.one(
        `SELECT * FROM (SELECT r.*, ${permissionSql("agent")} AS permission FROM agents r WHERE r.org_id = $2::uuid AND r.slug = $4) x WHERE permission IS NOT NULL`,
        [...aclParams(req.auth), (req.params as Row)["key"]],
      );
      if (!source) throw notFound("agent");
      let slug = `${String(source["slug"]).slice(0, 88)}-copy`;
      for (let n = 2; await ctx.db.one("SELECT 1 FROM agents WHERE org_id = $1 AND slug = $2", [req.auth.orgId, slug]); n++) {
        slug = `${String(source["slug"]).slice(0, 86)}-copy-${n}`;
      }
      const id = crypto.randomUUID();
      const created = await ctx.db.one(
        `INSERT INTO agents (id, org_id, owner_id, slug, name, description, avatar, instructions, runtime, model, provider_id, effort, permission_mode, skills, connectors)
         SELECT $1, org_id, $2, $3, name || ' (copy)', description, avatar, instructions, runtime, model, provider_id, effort, permission_mode, skills, connectors
           FROM agents WHERE id = $4 RETURNING *`,
        [id, req.auth.userId, slug, source["id"]],
      );
      await audit(ctx.db, req.auth, "agent.copy", { type: "agent", id }, { source: source["slug"] });
      return reply.code(201).send({ ...created, permission: "admin" });
    });
  });
}
