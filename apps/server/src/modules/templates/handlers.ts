import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { uploaded } from "../../infra/upload.ts";
import * as pack from "./pack.ts";
import * as projectPack from "./project-pack.ts";
import * as service from "./service.ts";

export const listAgentTemplates: Handler = async (req) => {
  const ctx = req.server.ctx;
  return { templates: await service.list(ctx, await requireAuth(ctx, req)) };
};

export const addAgentTemplate: Handler = async (req) => {
  const ctx = req.server.ctx;
  return service.add(ctx, await requireAuth(ctx, req), (req.params as { template_id: string }).template_id);
};

export const createAssistant: Handler = async (req) => {
  const ctx = req.server.ctx;
  return service.assistant(ctx, await requireAuth(ctx, req));
};

export const createExampleProject: Handler = async (req) => {
  const ctx = req.server.ctx;
  const { team_id } = req.body as Schema<"ExampleProjectRequest">;
  return service.exampleProject(ctx, await requireAuth(ctx, req), team_id);
};

export const exportAgentPack: Handler = async (req, reply) => {
  const ctx = req.server.ctx;
  const { bytes, filename } = await pack.exportPack(
    ctx,
    await requireAuth(ctx, req),
    req.body as Schema<"ExportPackRequest">,
  );
  return reply
    .header("content-type", "application/zip")
    .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .send(bytes);
};

export const importAgentPack: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const [file] = await uploaded(req);
  return pack.preview(ctx, auth, (file as NonNullable<typeof file>).bytes);
};

export const confirmAgentPackImport: Handler = async (req) => {
  const ctx = req.server.ctx;
  const { preview_id } = req.body as Schema<"ImportPackConfirmRequest">;
  return pack.confirm(ctx, await requireAuth(ctx, req), preview_id);
};

// -- A project as one file --

export const exportProject: Handler = async (req, reply) => {
  const ctx = req.server.ctx;
  const { bytes, filename } = await projectPack.exportProject(
    ctx,
    await requireAuth(ctx, req),
    (req.params as { project_id: string }).project_id,
  );
  return reply
    .header("content-type", "application/zip")
    .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .send(bytes);
};

export const importProjectPreview: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const [file] = await uploaded(req);
  return projectPack.preview(ctx, auth, (file as NonNullable<typeof file>).bytes);
};

export const confirmProjectImport: Handler = async (req) => {
  const ctx = req.server.ctx;
  const { preview_id } = req.body as Schema<"ImportProjectConfirmRequest">;
  return projectPack.confirm(ctx, await requireAuth(ctx, req), preview_id);
};
