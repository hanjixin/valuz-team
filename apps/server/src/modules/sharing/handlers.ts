import type { Schema } from "@agent-base/contract";
import { requireAuth } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import { notFound } from "../../infra/errors.ts";
import * as audit from "../audit/service.ts";
import * as notifications from "../notifications/service.ts";
import * as settings from "../settings/service.ts";
import * as service from "./service.ts";

/** The notice a member gets when something is shared with them, in their own language. */
const NOTICE = {
  "zh-CN": {
    types: {
      agent: "智能体",
      skill: "技能",
      connector: "连接器",
      provider: "模型通道",
      project: "项目",
      device: "设备",
      session: "会话",
      file: "文件",
    },
    levels: { view: "可查看", use: "可使用", edit: "可编辑", control: "可远程控制" },
    title: (who: string, what: string) => `${who} 向你共享了一个${what}`,
    body: (level: string) => `你${level}它。`,
  },
  "en-US": {
    types: {
      agent: "an agent",
      skill: "a skill",
      connector: "a connector",
      provider: "a model channel",
      project: "a project",
      device: "a device",
      session: "a session",
      file: "a file",
    },
    levels: { view: "can view", use: "can use", edit: "can edit", control: "can control" },
    title: (who: string, what: string) => `${who} shared ${what} with you`,
    body: (level: string) => `You ${level} it.`,
  },
} as const;

/** Where each kind of shared thing is found in the app. */
const ROUTES: Partial<Record<service.ShareableType, string>> = {
  agent: "/agents",
  project: "/",
  provider: "/settings?tab=model",
  device: "/settings?tab=team-devices",
};

interface Params {
  resource_type: service.ShareableType;
  resource_id: string;
  share_id: string;
}

/** Managing shares needs `admin` on the resource: its owner, or an organization owner/admin. */
const admin = async (req: Parameters<Handler>[0]) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  const { resource_type: type, resource_id: id, share_id: shareId } = req.params as Params;
  await service.requirePermission(ctx.db, auth, type, id, "admin");
  return { ctx, auth, type, id, shareId };
};

export const listShares: Handler = async (req) => {
  const { ctx, type, id } = await admin(req);
  return { shares: await service.listShares(ctx.db, type, id) };
};

export const putShare: Handler = async (req) => {
  const { ctx, auth, type, id } = await admin(req);
  const input = req.body as Schema<"ShareRequest">;
  const share = await service.putShare(ctx.db, auth, type, id, input);
  await audit.record(ctx.db, auth, "share.grant", { type, id }, { ...input, principal_id: share.principal_id });
  // Someone a thing was shared with by name should not have to stumble on it.
  if (share.principal_type === "user" && share.principal_id !== auth.userId) {
    const inbox = { orgId: auth.orgId, userId: share.principal_id };
    const locale = (await settings.getPreferences(ctx.db, inbox)).default_locale;
    const words = NOTICE[locale === "en-US" ? "en-US" : "zh-CN"];
    await notifications.notify(ctx, inbox, {
      kind: "shared",
      title: words.title(auth.name, words.types[type]),
      body: words.body(words.levels[share.permission]),
      route: ROUTES[type] ?? "/settings",
      payload: { resource_type: type, resource_id: id, permission: share.permission },
    });
  }
  return share;
};

export const deleteShare: Handler = async (req, reply) => {
  const { ctx, auth, type, id, shareId } = await admin(req);
  if (!(await service.deleteShare(ctx.db, type, id, shareId))) throw notFound("share");
  await audit.record(ctx.db, auth, "share.revoke", { type, id }, { share_id: shareId });
  return reply.code(204).send();
};
