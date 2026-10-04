/**
 * WeCom (企业微信) smart bots. Like a Feishu bot, one is bound to an agent and
 * each chat becomes a session. The bot's long connection is dialled by the
 * binder's device (`lines.ts`); the server keeps the bot's id and secret.
 */
import type { Ctx } from "../../infra/context.ts";

export const PLATFORM = "wecom-aibot";
const SECRET_PURPOSE = "channel";

export const seal = (ctx: Ctx, secret: string): string => ctx.box.seal(SECRET_PURPOSE, JSON.stringify({ secret }));
export const secretOf = (ctx: Ctx, binding: { secret_enc: string }): string =>
  (JSON.parse(ctx.box.open(SECRET_PURPOSE, binding.secret_enc)) as { secret?: string }).secret ?? "";
