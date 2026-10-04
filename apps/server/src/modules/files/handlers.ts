import type { Schema } from "@agent-base/contract";
import mime from "mime";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { uploaded } from "../../infra/upload.ts";
import * as sessions from "../sessions/service.ts";
import * as service from "./service.ts";

export const uploadAttachment: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const [file] = await uploaded(req);
  return service.upload(ctx, auth, file as NonNullable<typeof file>);
};

export const listStagedAttachments: Handler = async (req) => {
  const ctx = req.server.ctx;
  return { items: await service.listStaged(ctx, await requireAuth(ctx, req)) };
};

export const deleteAttachment: Handler = async (req, reply) => {
  const ctx = req.server.ctx;
  await service.discard(ctx, await requireAuth(ctx, req), (req.params as { attachment_id: string }).attachment_id);
  return reply.code(204).send();
};

export const listSessionAttachments: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const { session_id } = req.params as { session_id: string };
  await sessions.access(ctx, auth, session_id);
  return { items: await service.listForSession(ctx, session_id) };
};

/** Agents do not register deliverables yet, so a session has none to list. */
export const listSessionArtifacts: Handler = async (req) => {
  const ctx = req.server.ctx;
  await sessions.access(ctx, await requireAuth(ctx, req), (req.params as { session_id: string }).session_id);
  return { items: [] };
};

export const listArtifacts: Handler = async (req) => {
  await requireAuth(req.server.ctx, req);
  return { items: [], total: 0 };
};

export const listProjectFiles: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const { depth, path, include_hidden } = req.query as { depth?: number; path?: string; include_hidden?: boolean };
  return service.projectTree(ctx, auth, (req.params as { project_id: string }).project_id, {
    ...(depth === undefined ? {} : { depth }),
    ...(path ? { path } : {}),
    includeHidden: include_hidden === true,
  });
};

export const uploadProjectFiles: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  return service.uploadToProject(ctx, auth, (req.params as { project_id: string }).project_id, await uploaded(req));
};

export const resolveFiles: Handler = async (req) => {
  const auth = await requireAuth(req.server.ctx, req);
  return { results: await service.resolve(req.server, auth, (req.body as Schema<"ResolveFilesRequest">).refs) };
};

/** Public route: the token in the path is the authorization (see `resolveFiles`). */
export const readFileBytes: Handler = async (req, reply) => {
  const { bytes, name } = await service.readByToken(req.server, (req.params as { token: string }).token);
  const download = (req.query as { download?: string }).download !== undefined;
  return (
    reply
      .header("content-type", mime.getType(name) ?? "application/octet-stream")
      .header(
        "content-disposition",
        `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      // Whatever the file claims to be, the browser must not run it as a page of this origin.
      .header("content-security-policy", "sandbox")
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=60")
      .send(bytes)
  );
};
