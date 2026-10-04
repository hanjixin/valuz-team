import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];
const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req), itemId: (req.params as { item_id?: string }).item_id ?? "" };
};

export const listMarketplaceCategories: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return service.categories(ctx, auth, (req.query as { kind: string }).kind);
};

export const listMarketplaceItems: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return service.items(ctx, auth, req.query as Record<string, string | number | undefined>);
};

export const getMarketplaceItem: Handler = async (req) => {
  const { ctx, auth, itemId } = await caller(req);
  return service.item(ctx, auth, itemId);
};

export const installMarketplaceItem: Handler = async (req) => {
  const { ctx, auth, itemId } = await caller(req);
  return service.install(ctx, auth, itemId);
};
