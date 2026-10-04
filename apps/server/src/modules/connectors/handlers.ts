import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as settings from "../settings/service.ts";
import * as service from "./service.ts";

type Req = Parameters<Handler>[0];
const caller = async (req: Req) => {
  const ctx = req.server.ctx;
  return { ctx, auth: await requireAuth(ctx, req), key: (req.params as { connector_id?: string }).connector_id ?? "" };
};

export const listConnectors: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  return { connectors: await service.list(ctx, auth) };
};

export const createConnector: Handler = async (req, reply) => {
  const { ctx, auth } = await caller(req);
  return reply.code(201).send(await service.create(ctx, auth, req.body as Schema<"CreateConnectorRequest">));
};

export const getConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.get(ctx, auth, key);
};

export const updateConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.update(ctx, auth, key, req.body as Schema<"UpdateConnectorRequest">);
};

export const deleteConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  await service.remove(ctx, auth, key);
  return { ok: true };
};

export const enableConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.setEnabled(ctx, auth, key, true);
};

export const disableConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.setEnabled(ctx, auth, key, false);
};

export const testConnector: Handler = async (req) => {
  const { ctx, auth, key } = await caller(req);
  return service.test(ctx, auth, key);
};

/** OAuth-protected servers are not supported yet: every server is treated as taking a key or nothing. */
export const discoverConnector: Handler = async (req) => {
  await caller(req);
  return {
    auth_type: "none",
    discovered: false,
    oauth_authorization_endpoint: null,
    oauth_token_endpoint: null,
    oauth_registration_endpoint: null,
  };
};

/**
 * Ready-made connectors to add with one click. Only ones that work here are
 * listed: servers that need an OAuth sign-in are not supported yet, so of
 * valuz-agent's catalogue the one that takes no credentials remains. The
 * marketplace offers many more.
 */
const RECOMMENDED = [
  {
    kind: "connector",
    slug: "firecrawl",
    display_name: "Firecrawl",
    description: {
      "zh-CN": "网页抓取、爬取与搜索，提取结构化网页内容（免费匿名档，无需登录）",
      "en-US": "Scrape, crawl and search the web; extract structured page content (free anonymous tier, no login)",
    },
    icon_url: "https://www.firecrawl.dev/favicon.ico",
    categories: ["developer"],
    url: "https://mcp.firecrawl.dev/v2/mcp",
    auth_type: "none",
    transport: "http",
  },
] as const;

export const listRecommendedConnectors: Handler = async (req) => {
  const { ctx, auth } = await caller(req);
  const [mine, preferences] = await Promise.all([
    service.list(ctx, auth),
    settings.getPreferences(ctx.db, { orgId: auth.orgId, userId: auth.userId }),
  ]);
  const have = new Set(mine.map((connector) => connector.slug));
  const locale = preferences.default_locale === "en-US" ? "en-US" : "zh-CN";
  return {
    items: RECOMMENDED.map((entry) => ({
      ...entry,
      description: entry.description[locale],
      installed: have.has(entry.slug),
      oauth_credentials_schema: [],
      header_schema: [],
      param_schema: [],
    })),
  };
};
