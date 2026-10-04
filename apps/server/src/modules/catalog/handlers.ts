/**
 * Plugin bundles are not provided by this server. The app still asks what is
 * installed when some pages open, and the truthful answer is "nothing" — not
 * an error. Everything that would install, change or fetch one stays unimplemented.
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
