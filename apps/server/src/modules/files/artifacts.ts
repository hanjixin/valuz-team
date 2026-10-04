/**
 * Deliverables: files an agent produced and says are the result. The file
 * stays on the device; what is kept here is the record — which file, in which
 * project, delivered by which conversation, and each time it was delivered
 * again (a new version). Reading one goes through the device like any file.
 */
import path from "node:path";
import type { Db } from "@agent-base/db";
import mime from "mime";
import { authFor } from "../../infra/auth.ts";
import type { Auth, Ctx } from "../../infra/context.ts";
import { notFound } from "../../infra/errors.ts";
import { ToolError } from "../../infra/toolkit.ts";
import * as projects from "../projects/service.ts";
import * as sessions from "../sessions/service.ts";

export const ARTIFACT_TOOLKIT = { name: "artifacts", path: "/v1/mcp/artifacts" };

export const ARTIFACT_INSTRUCTIONS = [
  "## Deliverables",
  "When you have produced a file that is the result the user asked for — a report, a document, a spreadsheet, an",
  "archive — call `deliver_artifacts` with its path so it is listed as a deliverable of this conversation. Deliver",
  "the finished file, not scratch work; delivering the same path again records a new version.",
].join("\n");

export const ARTIFACT_TOOLS = [
  {
    name: "deliver_artifacts",
    description:
      "Mark files you produced as deliverables of this conversation. Each path is a file in the workspace (relative to the working directory, or absolute). Returns what was recorded, and which paths could not be found.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "The file's path." },
              name: { type: "string", description: "A display name (defaults to the file name)." },
            },
            required: ["path"],
          },
        },
      },
      required: ["files"],
    },
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refOf = (filePath: string): string => `valuz-file://${filePath}`;

/** The conversation a delivery comes from, and whose it is. */
export interface Deliverer {
  owner: Auth;
  sessionId: string;
  projectId: string;
  deviceId: string;
  cwd: string;
}

export async function authorize(ctx: Ctx, sessionId: string): Promise<Deliverer | null> {
  const session = await sessions.byId(ctx, sessionId);
  const owner = session ? await authFor(ctx, session.org_id, session.owner_id) : null;
  if (!session?.device_id || !owner) return null;
  return { owner, sessionId: session.id, projectId: session.project_id, deviceId: session.device_id, cwd: session.cwd };
}

export async function callTool(ctx: Ctx, by: Deliverer, tool: string, args: Record<string, unknown>) {
  if (tool !== "deliver_artifacts") throw new ToolError(`unknown tool "${tool}"`);
  const files = Array.isArray(args["files"]) ? (args["files"] as { path?: unknown; name?: unknown }[]) : [];
  if (files.length === 0) throw new ToolError("'files' must list at least one file");
  const delivered = [];
  const missing = [];
  for (const file of files.slice(0, 50)) {
    const given = typeof file.path === "string" ? file.path.trim() : "";
    if (!given) continue;
    // The device says where the file really is, and that it is one.
    const stat = (await ctx.hub
      .call(
        by.deviceId,
        "fs.stat",
        { path: path.posix.isAbsolute(given) ? given : `${by.cwd}/${given}` },
        { user_id: by.owner.userId, name: by.owner.name },
      )
      .catch(() => null)) as { path: string; kind?: string; size?: number } | null;
    if (!stat || stat.kind === "dir") {
      missing.push(given);
      continue;
    }
    const name = typeof file.name === "string" && file.name.trim() ? file.name.trim() : path.basename(stat.path);
    const version = await record(ctx.db, by, stat.path, name, stat.size ?? 0);
    delivered.push({ path: stat.path, name, version });
  }
  if (delivered.length === 0) throw new ToolError(`no such file: ${missing.join(", ") || "(none given)"}`);
  return { delivered, ...(missing.length > 0 ? { not_found: missing } : {}) };
}

/** Note a delivery: the deliverable at that path gains a version. */
function record(db: Db, by: Deliverer, filePath: string, name: string, size: number): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const artifact = await tx
      .insertInto("artifacts")
      .values({
        id: crypto.randomUUID(),
        org_id: by.owner.orgId,
        project_id: by.projectId,
        device_id: by.deviceId,
        file_path: filePath,
        display_name: name,
        version_no: 1,
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "file_path"]).doUpdateSet((eb) => ({
          version_no: eb("artifacts.version_no", "+", 1),
          display_name: name,
          device_id: by.deviceId,
          updated_at: new Date(),
        })),
      )
      .returning(["id", "version_no"])
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("artifact_revisions")
      .values({
        id: crypto.randomUUID(),
        artifact_id: artifact.id,
        version_no: artifact.version_no,
        session_id: by.sessionId,
        file_size: size,
        mime_type: mime.getType(filePath),
      })
      .execute();
    return artifact.version_no;
  });
}

const revisions = (db: Db) =>
  db
    .selectFrom("artifact_revisions as r")
    .innerJoin("artifacts as a", "a.id", "r.artifact_id")
    .select([
      "r.id",
      "r.artifact_id",
      "r.version_no",
      "r.session_id",
      "r.file_size",
      "r.mime_type",
      "r.created_at",
      "a.file_path",
      "a.display_name",
      "a.version_no as current_version",
      "a.updated_at",
    ]);

type RevisionRow = Awaited<ReturnType<ReturnType<typeof revisions>["execute"]>>[number];

const presentRevision = (row: RevisionRow) => ({
  id: row.id,
  version_no: row.version_no,
  file_name: path.basename(row.file_path),
  file_path: row.file_path,
  ref: refOf(row.file_path),
  file_size: Number(row.file_size),
  mime_type: row.mime_type,
  status: row.version_no === row.current_version ? "current" : "superseded",
  source_session_id: row.session_id,
  created_at: row.created_at.getTime(),
});

/** What one conversation delivered, oldest first — each as the version it delivered. */
export async function forSession(ctx: Ctx, sessionId: string) {
  const rows = await revisions(ctx.db).where("r.session_id", "=", sessionId).orderBy("r.created_at").execute();
  return rows.map((row) => ({
    id: row.id,
    session_id: sessionId,
    file_path: row.file_path,
    ref: refOf(row.file_path),
    file_name: row.display_name,
    file_size: Number(row.file_size),
    mime_type: row.mime_type,
    created_at: row.created_at.getTime(),
    artifact_id: row.artifact_id,
    version_no: row.version_no,
    is_current: row.version_no === row.current_version,
    kind: "file",
  }));
}

/** A project's deliverables, most recently delivered first, each with its current version. */
export async function forProject(ctx: Ctx, auth: Auth, projectId: string, limit: number) {
  const project = await projects.require(ctx, auth, projectId);
  const rows = await revisions(ctx.db)
    .where("a.project_id", "=", project.id)
    .whereRef("r.version_no", "=", "a.version_no")
    .orderBy("a.updated_at", "desc")
    .limit(limit)
    .execute();
  const items = rows.map((row) => ({
    id: row.artifact_id,
    display_name: row.display_name,
    kind: "file",
    version_no: row.version_no,
    updated_at: row.updated_at.getTime(),
    current: presentRevision(row),
  }));
  return { items, total: items.length };
}

export async function history(ctx: Ctx, auth: Auth, artifactId: string) {
  const artifact = UUID.test(artifactId)
    ? await ctx.db.selectFrom("artifacts").selectAll().where("id", "=", artifactId).executeTakeFirst()
    : undefined;
  if (!artifact || artifact.org_id !== auth.orgId) throw notFound("artifact");
  // Seen by whoever sees its project.
  await projects.require(ctx, auth, artifact.project_id).catch(() => {
    throw notFound("artifact");
  });
  const rows = await revisions(ctx.db).where("a.id", "=", artifact.id).orderBy("r.version_no", "desc").execute();
  return { artifact_id: artifact.id, display_name: artifact.display_name, items: rows.map(presentRevision) };
}

/** Which device holds a delivered file, for a caller who may see its project. */
export async function deviceOf(ctx: Ctx, auth: Auth, filePath: string): Promise<string | null> {
  const row = await ctx.db
    .selectFrom("artifacts")
    .select(["device_id", "project_id"])
    .where("org_id", "=", auth.orgId)
    .where("file_path", "=", filePath)
    .executeTakeFirst();
  if (!row?.device_id) return null;
  return (await projects.require(ctx, auth, row.project_id).catch(() => null)) ? row.device_id : null;
}
