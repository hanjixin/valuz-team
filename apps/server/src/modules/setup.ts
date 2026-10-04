/**
 * What modules do once per server, beyond answering contract operations:
 * routes the contract cannot describe, and subscriptions to infrastructure.
 */
import type { FastifyInstance } from "fastify";
import { registerDeviceLink } from "./devices/link.ts";
import * as devices from "./devices/service.ts";
import * as sessions from "./sessions/ingest.ts";

export function setupModules(app: FastifyInstance): void {
  devices.attach(app.ctx);
  sessions.attach(app.ctx);
  registerDeviceLink(app);
}
