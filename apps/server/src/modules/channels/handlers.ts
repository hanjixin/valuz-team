import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as chats from "./chats.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];

const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req), slug: (req.params as { agent_slug: string }).agent_slug };
};

export const getFeishuBinding: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return service.getFeishu(ctx, auth, slug);
};

export const updateFeishuBinding: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return service.putFeishu(ctx, auth, slug, req.body as Schema<"FeishuBindingUpdate">);
};

export const testFeishuBinding: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return service.testFeishu(ctx, auth, slug);
};

export const getWeComAIBotBinding: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return service.getWeCom(ctx, auth, slug);
};

export const updateWeComAIBotBinding: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return service.putWeCom(ctx, auth, slug, req.body as Schema<"WeComAIBotBindingUpdate">);
};

// -- Groups, and the projects they stand for --

const member = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req) };
};
const chatOf = (req: Req): string => (req.params as { external_chat_id: string }).external_chat_id;

export const listFeishuChats: Handler = async (req, reply) => {
  const { ctx, auth } = await member(req);
  void reply.header("cache-control", "no-store");
  return chats.listChats(ctx, auth, (req.query as { agent_slug?: string }).agent_slug);
};

export const createFeishuChat: Handler = async (req, reply) => {
  const { ctx, auth } = await member(req);
  return reply.code(201).send(await chats.create(ctx, auth, req.body as { name: string; project_id: string }));
};

export const getFeishuChatLink: Handler = async (req, reply) => {
  const { ctx, auth } = await member(req);
  void reply.header("cache-control", "no-store");
  return chats.link(ctx, auth, chatOf(req));
};

export const deleteFeishuChat: Handler = async (req, reply) => {
  const { ctx, auth } = await member(req);
  await chats.dissolve(ctx, auth, chatOf(req));
  return reply.code(204).send();
};

export const listChatBindings: Handler = async (req, reply) => {
  const { ctx, auth } = await member(req);
  // Read right after binding, unbinding or dissolving: a cached copy would show the state before.
  void reply.header("cache-control", "no-store");
  return chats.listBindings(ctx, auth, (req.query as { project_id?: string }).project_id);
};

export const bindChatToProject: Handler = async (req) => {
  const { ctx, auth } = await member(req);
  return chats.bind(ctx, auth, req.body as Parameters<typeof chats.bind>[2]);
};

export const unbindChat: Handler = async (req, reply) => {
  const { ctx, auth } = await member(req);
  await chats.unbind(ctx, auth, (req.query as { external_chat_id: string }).external_chat_id);
  return reply.code(204).send();
};
