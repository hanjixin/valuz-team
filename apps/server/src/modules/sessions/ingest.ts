/**
 * What devices report back: the events of a turn, changes to a session, and
 * the final state of each turn. Every frame may arrive more than once (the
 * host resends until acked), so each write here is idempotent.
 */
import type { Ctx } from "../../infra/context.ts";
import { orgChannel } from "../../infra/pubsub.ts";
import { closeStrandedTurn, drain, sessionChannel } from "./dispatch.ts";
import * as repo from "./repo.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function attach(ctx: Ctx): void {
  ctx.hub.listen({
    async hello(device, _info, running) {
      // Anything the server believes is running here but the host does not know about
      // died with the host's previous process.
      const known = running.filter((id) => UUID.test(id));
      for (const sessionId of await repo.strandedOn(ctx.db, device.id, known))
        await closeStrandedTurn(ctx, sessionId, "the device restarted mid-turn");
    },

    async state(device, frame) {
      switch (frame.t) {
        case "event": {
          // A device may only write state for sessions that run on it.
          if (!(await repo.runsOnDevice(ctx.db, device.id, frame.session_id))) return;
          const stored = await repo.appendEvent(ctx.db, {
            session_id: frame.session_id,
            message_id: frame.message_id,
            type: frame.type,
            data: frame.data,
            ts: frame.timestamp,
            event_uid: frame.uid,
          });
          if (stored) await ctx.pubsub.publish(sessionChannel(frame.session_id), stored);
          return;
        }
        case "session.patch": {
          const orgId = await repo.applyPatch(ctx.db, device.id, frame.session_id, frame.patch);
          if (orgId && frame.patch.status !== undefined)
            await ctx.pubsub.publish(orgChannel(orgId), {
              type: "session.updated",
              session_id: frame.session_id,
              status: frame.patch.status,
            });
          return;
        }
        case "message.upsert": {
          const { message } = frame;
          if (!(await repo.runsOnDevice(ctx.db, device.id, message.session_id))) return;
          await repo.upsertMessage(ctx.db, message);
          // A finished turn makes room for the next queued input. Never hold the
          // device's frames up for it: the next turn is a dispatch of its own.
          if (message.status !== "running")
            void drain(ctx, message.session_id).catch((err: unknown) =>
              ctx.log(err, `session ${message.session_id}: draining the queue failed`),
            );
        }
      }
    },
  });
}
