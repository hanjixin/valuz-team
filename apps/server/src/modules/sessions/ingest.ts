/**
 * What devices report back: the events of a turn, changes to a session, and
 * the final state of each turn. Every frame may arrive more than once (the
 * host resends until acked), so each write here is idempotent.
 */
import type { Ctx } from "../../infra/context.ts";
import { orgChannel } from "../../infra/pubsub.ts";
import { announce, closeStrandedTurn, drain } from "./dispatch.ts";
import * as repo from "./repo.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function attach(ctx: Ctx): void {
  /**
   * A turn ending makes room for the next queued input. The device reports the
   * end twice — the turn's final state and the session going idle — in either
   * order, so both ask; taking an input off the queue is atomic, and a session
   * still marked running is left alone. Never hold the device's frames up for
   * it: the next turn is a dispatch of its own.
   */
  const next = (sessionId: string): void =>
    void drain(ctx, sessionId).catch((err: unknown) => ctx.log(err, `session ${sessionId}: draining the queue failed`));

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
          const orgId = await repo.orgOfSessionOn(ctx.db, device.id, frame.session_id);
          if (!orgId) return;
          const stored = await repo.appendEvent(ctx.db, {
            session_id: frame.session_id,
            message_id: frame.message_id,
            type: frame.type,
            data: frame.data,
            ts: frame.timestamp,
            event_uid: frame.uid,
          });
          if (stored) await announce(ctx, orgId, frame.session_id, stored);
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
          if (orgId && frame.patch.status === "idle") next(frame.session_id);
          return;
        }
        case "message.upsert": {
          const { message } = frame;
          if (!(await repo.orgOfSessionOn(ctx.db, device.id, message.session_id))) return;
          await repo.upsertMessage(ctx.db, message);
          if (message.status !== "running") next(message.session_id);
        }
      }
    },
  });
}
