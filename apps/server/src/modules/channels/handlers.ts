import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as feishu from "./feishu.ts";
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

/** Public route: the platform calls it, and the binding's token or signature is the authorization. */
export const feishuChannelCallback: Handler = async (req) =>
  feishu.callback(
    req.server,
    (req.params as { channel_instance_id: string }).channel_instance_id,
    req.headers,
    req.body as Record<string, unknown>,
  );

export const getWeComAIBotBinding: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return service.getWeCom(ctx, auth, slug);
};

export const updateWeComAIBotBinding: Handler = async (req) => {
  const { ctx, auth, slug } = await caller(req);
  return service.putWeCom(ctx, auth, slug, req.body as Schema<"WeComAIBotBindingUpdate">);
};
