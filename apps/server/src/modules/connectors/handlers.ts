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

/** What the server at this address says about signing in to it, so the form can ask for the right thing. */
export const discoverConnector: Handler = async (req) => {
  const { ctx } = await caller(req);
  return service.discover(ctx, String((req.body as { url?: string }).url ?? "").trim());
};

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * Where a browser lands after a person signed in to a connector's server. Public: the `state` in
 * the address is the authorization. It answers with a page for a person, and tells the window that
 * opened it (the app) how it went.
 */
export const connectorOAuthCallback: Handler = async (req, reply) => {
  const outcome = await service.signedIn(req.server.ctx, req.query as Record<string, string>);
  const message = JSON.stringify(
    outcome.ok ? { type: "connector_oauth_success" } : { type: "connector_oauth_error", error: outcome.message },
  ).replace(/</g, "\\u003c");
  return reply
    .code(outcome.ok ? 200 : 400)
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(
      `<!doctype html><meta charset="utf-8"><title>${outcome.ok ? "Signed in" : "Sign-in failed"}</title>` +
        `<body style="font:16px system-ui;margin:15vh auto;max-width:28rem;text-align:center;color:#222">` +
        `<h1 style="font-size:1.25rem">${outcome.ok ? "✓" : "✗"} ${escapeHtml(outcome.message)}</h1>` +
        `<script>try{window.opener&&window.opener.postMessage(${message},"*")}catch(e){}` +
        `${outcome.ok ? "setTimeout(function(){window.close()},1500)" : ""}</script></body>`,
    );
};

/**
 * Ready-made connectors to add with one click: valuz-agent's catalogue, without the entries that
 * are that product's own data service. The ones that say `oauth` send the member to sign in.
 */
interface Recommended {
  kind: "connector";
  slug: string;
  display_name: string;
  description: string | { "zh-CN": string; "en-US": string };
  icon_url: string;
  categories: string[];
  url: string;
  auth_type: "none" | "oauth";
  transport: "http";
  credentials_help_url?: string;
  /** What the member must bring: a client they registered, where the server registers none itself. */
  oauth_credentials_schema?: { key: string; label: string; placeholder: string; required: boolean; secret: boolean }[];
}

const RECOMMENDED: Recommended[] = [
  {
    kind: "connector",
    slug: "github",
    display_name: "GitHub",
    description: {
      "zh-CN": "访问 GitHub 的仓库、Issue、Pull Request 等。需要先在 GitHub 注册一个 OAuth App。",
      "en-US": "Access GitHub repositories, issues, pull requests and more. Needs an OAuth App registered with GitHub.",
    },
    icon_url: "https://github.com/favicon.ico",
    categories: ["developer"],
    url: "https://api.githubcopilot.com/mcp/",
    auth_type: "oauth",
    transport: "http",
    credentials_help_url: "https://github.com/settings/developers",
    oauth_credentials_schema: [
      { key: "client_id", label: "Client ID", placeholder: "Ov23li...", required: true, secret: false },
      { key: "client_secret", label: "Client Secret", placeholder: "Client Secret", required: true, secret: true },
    ],
  },
  {
    kind: "connector",
    slug: "linear",
    display_name: "Linear",
    description: {
      "zh-CN": "管理 Linear 的 Issue、项目和迭代。",
      "en-US": "Manage Linear issues, projects and cycles.",
    },
    icon_url: "https://linear.app/favicon.ico",
    categories: ["productivity"],
    url: "https://mcp.linear.app/mcp",
    auth_type: "oauth",
    transport: "http",
  },
  {
    kind: "connector",
    slug: "notion",
    display_name: "Notion",
    description: { "zh-CN": "读写 Notion 的页面和数据库。", "en-US": "Read and write Notion pages and databases." },
    icon_url: "https://www.notion.so/images/favicon.ico",
    categories: ["productivity"],
    url: "https://mcp.notion.com/mcp",
    auth_type: "oauth",
    transport: "http",
  },
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
];

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
      description: typeof entry.description === "string" ? entry.description : entry.description[locale],
      installed: have.has(entry.slug),
      oauth_credentials_schema: entry.oauth_credentials_schema ?? [],
      header_schema: [],
      param_schema: [],
    })),
  };
};
