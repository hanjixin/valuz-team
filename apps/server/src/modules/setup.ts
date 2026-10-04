/**
 * What modules do once per server, beyond answering contract operations:
 * routes the contract cannot describe, and subscriptions to infrastructure.
 */
import type { FastifyInstance } from "fastify";
import { mountToolkit } from "../infra/toolkit.ts";
import { registerDeviceLink } from "./devices/link.ts";
import * as devices from "./devices/service.ts";
import { onSessionIdle, onTurnEnd, registerTurnExtras } from "./sessions/dispatch.ts";
import * as sessions from "./sessions/ingest.ts";
import { TASK_TOOLKIT } from "./tasks/prompts.ts";
import * as tasks from "./tasks/service.ts";
import { LEAD_TOOLS } from "./tasks/tools.ts";

export function setupModules(app: FastifyInstance): void {
  devices.attach(app.ctx);
  sessions.attach(app.ctx);

  // Tasks ride on sessions: each of a task's sessions is told its part, a turn
  // ending moves the task on, and the lead reaches the orchestrator as a tool server.
  registerTurnExtras(app.ctx, (session) => tasks.turnExtras(app, session));
  onTurnEnd(app.ctx, (turn) => tasks.handleTurnEnd(app.ctx, turn));
  onSessionIdle(app.ctx, (sessionId) => tasks.handleSessionIdle(app.ctx, sessionId));
  mountToolkit<tasks.Caller>(app, {
    ...TASK_TOOLKIT,
    tools: LEAD_TOOLS,
    authorize: (sessionId) => tasks.authorizeToolCaller(app.ctx, sessionId),
    call: (caller, tool, args) => tasks.callTool(app.ctx, caller, tool, args),
  });
  registerDeviceLink(app);
}
