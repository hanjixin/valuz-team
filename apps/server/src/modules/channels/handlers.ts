import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
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
