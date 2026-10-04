/**
 * Where a bot's connection to its chat platform lives: on a device. The server
 * holds none. It tells the binder's device which bots to keep connected (and
 * hands it their credentials), hears from the device what people said, and
 * asks the device to post the answers.
 */
import type { ChannelBot, ChannelBotStatus } from "@agent-base/protocol";
import type { Ctx } from "../../infra/context.ts";
import * as devices from "../devices/service.ts";
import * as chat from "./chat.ts";
import * as feishu from "./feishu.ts";
import * as repo from "./repo.ts";
import * as wecom from "./wecom.ts";

const STATUS_TIMEOUT_MS = 5000;

const botOf = (ctx: Ctx, row: repo.BindingRow): ChannelBot =>
  row.platform === feishu.PLATFORM
    ? {
        id: row.id,
        platform: "feishu",
        app_id: row.app_id,
        secret: feishu.secretsOf(ctx, row).app_secret,
        endpoint: ctx.config.FEISHU_API_BASE,
      }
    : {
        id: row.id,
        platform: "wecom-aibot",
        app_id: row.app_id,
        secret: wecom.secretOf(ctx, row),
        endpoint: ctx.config.WECOM_WS_URL,
      };

/**
 * Tell a device which bots it keeps connected — all of them, so one message
 * covers a bot made, changed, switched off or moved away. A device that is
 * offline is told when it next says hello.
 */
export async function sync(ctx: Ctx, deviceId: string | null): Promise<void> {
  const owner = deviceId ? await devices.ownerOf(ctx, deviceId) : undefined;
  if (!deviceId || !owner) return;
  // Credentials go only to a device of the member who entered them.
  const bots = (await repo.listOnDevice(ctx.db, deviceId)).filter((row) => row.owner_id === owner.owner_id);
  await ctx.hub
    .call(deviceId, "channels.sync", { bots: bots.map((row) => botOf(ctx, row)) }, chat.actorOf(owner.owner_id))
    .catch((err: unknown) => {
      if ((err as { code?: string }).code !== "device_offline") ctx.log(err, `device ${deviceId}: bots not synced`);
    });
}

/** A bot's connection as its device reports it, in the words the app shows. */
export async function connection(
  ctx: Ctx,
  binding: repo.BindingRow,
): Promise<{ connected: boolean; connection_status: string; connection_error: string | null }> {
  if (!binding.enabled) return { connected: false, connection_status: "disabled", connection_error: null };
  const down = (reason: string) => ({ connected: false, connection_status: "disconnected", connection_error: reason });
  if (!binding.device_id) return down("没有可用的设备：机器人的连接由绑定者的设备保持，请先连接一台设备。");
  try {
    const { bots } = (await ctx.hub.call(
      binding.device_id,
      "channels.status",
      {},
      chat.actorOf(binding.owner_id),
      STATUS_TIMEOUT_MS,
    )) as { bots: Record<string, ChannelBotStatus> };
    const status = bots[binding.id];
    if (!status) return down("设备尚未建立这个机器人的连接。");
    return { connected: status.connected, connection_status: status.status, connection_error: status.error };
  } catch {
    return down("保持这个机器人连接的设备当前不在线。");
  }
}

/** Follow devices: one saying hello is told its bots; what its bots hear becomes turns. */
export function attach(ctx: Ctx): void {
  ctx.hub.listen({
    async hello(device) {
      const owner = await devices.ownerOf(ctx, device.id);
      if (!owner) return;
      await repo.claim(ctx.db, owner.org_id, owner.owner_id, device.id);
      // Not awaited: the device answers on the link this hello is still being handled on.
      void sync(ctx, device.id);
    },
    async state(device, frame) {
      if (frame.t !== "channel.message") return;
      const binding = /^[0-9a-f-]{36}$/i.test(frame.bot_id) ? await repo.byId(ctx.db, frame.bot_id) : undefined;
      // A device speaks only for the bots it was given.
      if (!binding?.enabled || binding.device_id !== device.id) return;
      if (!(await chat.firstTime(ctx, binding.id, frame.event_id || frame.uid))) return;
      // The turn is started in the background: the frame is acked as soon as it is taken.
      void (
        frame.text === null
          ? chat.decline(ctx, binding, frame.chat_id)
          : chat.hear(ctx, binding, frame.chat_id, frame.text)
      ).catch((err: unknown) => ctx.log(err, `channel ${binding.id}: message failed`));
    },
  });
}
