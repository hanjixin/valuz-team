/**
 * Feishu bots. One is bound to an agent; every chat the bot is in becomes a
 * session with that agent, and the agent's answers go back to the chat.
 *
 * The bot's long connection is dialled by the binder's device (`lines.ts`), and
 * that is the only way its events arrive: the server takes no callback from the
 * platform and posts nothing to it. All it does itself is check an app's
 * credentials when asked.
 */
import * as lark from "@larksuiteoapi/node-sdk";
import type { Ctx } from "../../infra/context.ts";
import type * as repo from "./repo.ts";

export const PLATFORM = "feishu";
const SECRET_PURPOSE = "channel";

export interface Secrets {
  app_secret: string;
}

export const seal = (ctx: Ctx, secrets: Secrets): string => ctx.box.seal(SECRET_PURPOSE, JSON.stringify(secrets));
export const secretsOf = (ctx: Ctx, binding: { secret_enc: string }): Secrets =>
  JSON.parse(ctx.box.open(SECRET_PURPOSE, binding.secret_enc)) as Secrets;

/** Whether the platform accepts these app credentials; the reason when it does not. */
export async function checkCredentials(ctx: Ctx, binding: repo.BindingRow): Promise<string | null> {
  const appSecret = secretsOf(ctx, binding).app_secret;
  try {
    const client = new lark.Client({
      appId: binding.app_id,
      appSecret,
      domain: ctx.config.FEISHU_API_BASE || lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
    });
    const res = (await client.auth.tenantAccessToken.internal({
      data: { app_id: binding.app_id, app_secret: appSecret },
    })) as { code?: number; msg?: string };
    return res.code === 0 ? null : (res.msg ?? "unknown error");
  } catch (err) {
    return (err as Error).message;
  }
}
