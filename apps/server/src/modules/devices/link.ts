import { DEVICE_LINK_PATH } from "@agent-base/protocol";
import type { FastifyInstance } from "fastify";
import { unauthorized } from "../../infra/errors.ts";
import * as service from "./service.ts";

/**
 * The device link endpoint. It is a WebSocket, so it lives outside the HTTP
 * contract, and it authenticates with the device's own token, not a user's.
 *
 * The token is checked before the upgrade, which keeps the socket handler
 * synchronous: a host sends its hello the instant the socket opens, and a
 * listener attached after an await would miss it.
 */
export function registerDeviceLink(app: FastifyInstance): void {
  const linked = new WeakMap<object, { id: string; org_id: string }>();
  app.get(
    DEVICE_LINK_PATH,
    {
      websocket: true,
      preValidation: async (req) => {
        const header = req.headers.authorization;
        const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
        const device = token ? await service.authenticate(app.ctx.db, token) : undefined;
        if (!device) throw unauthorized("invalid or revoked device token");
        linked.set(req.raw, device);
      },
    },
    (socket, req) => {
      const device = linked.get(req.raw);
      if (!device) return socket.close(4401, "invalid device token");
      app.ctx.hub.attach(device.id, device.org_id, socket);
    },
  );
}
