import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { uploaded } from "../../infra/upload.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  const params = req.params as { kb_id?: string; doc_id?: string; project_id?: string; task_id?: string };
  return { ctx, auth: await requireAuth(ctx, req), params };
};

export const listKnowledgeBases: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return { knowledge_bases: await service.list(ctx, auth) };
};

export const createKnowledgeBase: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  const body = req.body as Schema<"KnowledgeBaseCreateRequest">;
  return reply.code(201).send(await service.create(ctx, auth, body));
};

export const getKnowledgeBase: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  return service.get(ctx, auth, params.kb_id ?? "");
};

export const updateKnowledgeBase: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  return service.rename(ctx, auth, params.kb_id ?? "", (req.body as Schema<"KnowledgeBaseUpdateRequest">).name);
};

export const deleteKnowledgeBase: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  await service.remove(ctx, auth, params.kb_id ?? "");
  return { kb_id: params.kb_id };
};

export const uploadKnowledgeBaseFiles: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  return service.upload(ctx, auth, params.kb_id ?? "", await uploaded(req));
};

export const rescanKnowledgeBase: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  return service.rescan(ctx, auth, params.kb_id ?? "");
};

export const getKnowledgeBaseTree: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  const { folder_id } = req.query as { folder_id?: string };
  return { nodes: await service.tree(ctx, auth, params.kb_id ?? "", folder_id) };
};

export const listDocuments: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  const { q, status, kb_id } = req.query as { q?: string; status?: string; kb_id?: string };
  return {
    documents: await service.listDocuments(ctx, auth, {
      ...(q ? { q } : {}),
      ...(status ? { status } : {}),
      ...(kb_id ? { kbId: kb_id } : {}),
    }),
  };
};

export const getDocument: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  return service.getDocument(ctx, auth, params.doc_id ?? "");
};

export const deleteDocument: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  await service.removeDocument(ctx, auth, params.doc_id ?? "");
  return { document_id: params.doc_id };
};

export const getDocumentPreview: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  const { offset, max_bytes } = req.query as { offset?: number; max_bytes?: number };
  return service.preview(ctx, auth, params.doc_id ?? "", offset ?? 0, max_bytes ?? 200_000);
};

export const reindexDocuments: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return service.reindex(ctx, auth, (req.body as { document_ids: string[] }).document_ids);
};

export const searchDocuments: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return { hits: await service.search(ctx, auth, req.body as Schema<"SearchRequest">) };
};

export const getImportTask: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  return service.task(ctx, auth, params.task_id ?? "");
};

export const docsHealth: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return service.health(ctx, auth);
};

export const listProjectKbBindings: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  return { bindings: await service.bindings(ctx, auth, params.project_id ?? "") };
};

export const updateProjectKbBindings: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  const { bindings } = req.body as Schema<"KbBindingUpdate">;
  return { bindings: await service.setBindings(ctx, auth, params.project_id ?? "", bindings) };
};

export const deleteProjectKbBindings: Handler = async (req) => {
  const { ctx, auth, params } = await caller(req);
  await service.setBindings(ctx, auth, params.project_id ?? "", []);
  return { ok: true };
};
