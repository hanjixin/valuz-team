import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req), id: (req.params as { provider_id?: string }).provider_id ?? "" };
};

export const listProviderDescriptors: Handler = async (req) => {
  await caller(req);
  return { providers: service.listDescriptors() };
};

export const listProviders: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return { providers: await service.list(ctx, auth) };
};

export const getProvider: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.get(ctx, auth, id);
};

export const createProvider: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  return reply.code(201).send(await service.create(ctx, auth, req.body as Schema<"ProviderCreateRequest">));
};

export const updateProvider: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.update(ctx, auth, id, req.body as Schema<"ProviderUpdateRequest">);
};

export const deleteProvider: Handler = async (req, reply) => {
  const { ctx, auth, id } = await caller(req);
  await service.remove(ctx, auth, id);
  return reply.code(204).send();
};

export const testProvider: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.test(ctx, auth, id);
};

export const validateProviderCredentials: Handler = async (req) => {
  const { ctx } = await caller(req);
  return service.validate(ctx, req.body as Schema<"ProviderValidateRequest">);
};

export const pingProviderModels: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return service.ping(ctx, auth, req.body as Schema<"ProviderPingRequest">);
};

export const probeProviderModels: Handler = async (req) => {
  const { ctx } = await caller(req);
  return service.probe(ctx, req.body as Schema<"ProbeModelsRequest">);
};

export const discoverProviderModels: Handler = async (req) => {
  const { ctx, auth, id } = await caller(req);
  return service.refreshModels(ctx, auth, id);
};

export const setDefaultProvider: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  const { provider_id, default_model } = req.body as Schema<"SetDefaultProviderRequest">;
  await service.setDefault(ctx, auth, provider_id, default_model);
  return { provider_id, message: "Default provider updated" };
};

export const getModelDefaults: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return service.getDefaults(ctx, auth);
};

export const patchModelDefaults: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return service.patchDefaults(ctx, auth, req.body as Schema<"ModelDefaultsPatch">);
};

export const getModelOptions: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return service.modelOptions(ctx, auth);
};
