/**
 * Plugin bundles and the marketplace are not provided by this server. The app
 * still asks what is installed and what is on offer when some pages open, and
 * the truthful answer to both is "nothing" — not an error. Everything that
 * would install, change or fetch one stays unimplemented.
 */
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";

export const listPlugins: Handler = async (req) => {
  await requireAuth(req.server.ctx, req);
  return { items: [] };
};

/** No skill or connector belongs to a plugin. */
export const getPluginMemberships: Handler = async (req) => {
  await requireAuth(req.server.ctx, req);
  return {};
};

export const listMarketplaceCategories: Handler = async (req) => {
  await requireAuth(req.server.ctx, req);
  return { categories: [], degraded: false };
};

export const listMarketplaceItems: Handler = async (req) => {
  await requireAuth(req.server.ctx, req);
  const { page, page_size } = req.query as { page?: number; page_size?: number };
  return { items: [], total: 0, page: page ?? 1, page_size: page_size ?? 20, degraded: false };
};
