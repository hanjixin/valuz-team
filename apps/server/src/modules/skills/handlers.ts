import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { badRequest } from "../../infra/errors.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  const params = req.params as { skill_id?: string; revision_id?: string; project_id?: string; file_path?: string };
  return { ctx, auth: await requireAuth(ctx, req), key: params.skill_id ?? "", params };
};

/** The library is the same whichever project asks; the project id is echoed back. */
const catalog = async (req: Req, projectId: string) => {
  const { ctx, auth } = await caller(req);
  return { project_id: projectId, skills: await service.list(ctx, auth) };
};

export const listSkills: Handler = (req) => catalog(req, (req.query as { project_id?: string }).project_id ?? "");

export const projectSkillsCatalog: Handler = (req) => catalog(req, (req.params as { project_id: string }).project_id);

/** Skills live in the database, so there is nothing on disk to rescan; this reports how many there are. */
export const rescanSkills: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  // The library's own skills; the built-in ones ship with the server and are not indexed.
  return { indexed: (await service.list(ctx, auth)).filter((skill) => skill.source !== "builtin").length };
};

export const listSkillTags: Handler = async (req) => {
  await caller(req);
  return { tags: [] };
};

export const createSkill: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  return reply.code(201).send(await service.create(ctx, auth, req.body as Schema<"SkillCreateRequest">));
};

export const getSkill: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.get(ctx, auth, key);
};

export const updateSkill: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.update(ctx, auth, key, req.body as Schema<"SkillUpdateRequest">);
};

/** `dry_run` (the default) says what deleting would affect; `confirm` deletes. */
export const deleteSkill: Handler = async (req, reply) => {
  const { ctx, auth, key } = await caller(req);
  if ((req.query as { mode?: string }).mode !== "confirm") {
    await service.get(ctx, auth, key);
    return { affected_projects: [] };
  }
  await service.remove(ctx, auth, key);
  return reply.code(204).send();
};

export const copySkill: Handler = async (req, reply) => {
  const { ctx, auth, key } = await caller(req);
  return reply.code(201).send(await service.copy(ctx, auth, key, (req.body as Schema<"SkillCopyRequest">).new_name));
};

export const setSkillLibraryState: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.setLibraryState(ctx, auth, key, (req.body as Schema<"SkillLibraryStateRequest">).enabled);
};

export const listSkillFiles: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.listFiles(ctx, auth, key);
};

export const getSkillFileContent: Handler = async (req) => {
  const { ctx, auth, key, params } = await caller(req);
  return service.readFile(ctx, auth, key, params.file_path ?? "");
};

export const updateSkillFile: Handler = async (req, reply) => {
  const { ctx, auth, key } = await caller(req);
  return reply.code(201).send(await service.changeFile(ctx, auth, key, req.body as Schema<"SkillFileAction">));
};

export const listSkillVersions: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.listVersions(ctx, auth, key);
};

export const getSkillVersion: Handler = async (req) => {
  const { ctx, auth, key, params } = await caller(req);
  return service.getVersion(ctx, auth, key, params.revision_id ?? "");
};

export const readSkillVersionFile: Handler = async (req) => {
  const { ctx, auth, key, params } = await caller(req);
  const { path } = req.query as { path?: string };
  if (!path) throw badRequest("say which file with ?path=");
  return service.readVersionFile(ctx, auth, key, params.revision_id ?? "", path);
};

export const restoreSkillVersion: Handler = async (req) => {
  const { ctx, auth, key, params } = await caller(req);
  return service.restoreVersion(ctx, auth, key, params.revision_id ?? "");
};

export const getSkillSettings: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return service.learningSettings(ctx, auth);
};

export const patchSkillSettings: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return service.patchLearningSettings(ctx, auth, req.body as Schema<"SkillSettings">);
};
