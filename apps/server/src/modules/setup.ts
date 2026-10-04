/**
 * What modules do once per server, beyond answering contract operations:
 * routes the contract cannot describe, and subscriptions to infrastructure.
 */
import type { FastifyInstance } from "fastify";
import { mountToolkit, toolkitServer } from "../infra/toolkit.ts";
import { registerDeviceLink } from "./devices/link.ts";
import * as parser from "./knowledge/parse.ts";
import * as knowledge from "./knowledge/service.ts";
import { DOCS_INSTRUCTIONS, DOCS_TOOLKIT, DOCS_TOOLS, callTool as callDocsTool } from "./knowledge/tools.ts";
import * as devices from "./devices/service.ts";
import * as memoryReview from "./memory/review.ts";
import * as memory from "./memory/service.ts";
import {
  MEMORY_TOOLKIT,
  MEMORY_TOOLS,
  authorize as authorizeMemory,
  callTool as callMemoryTool,
} from "./memory/tools.ts";
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

  // The knowledge base: uploads are parsed in the background, and a session whose
  // scope holds any document is given the tools to consult it.
  parser.start(app);
  registerTurnExtras(app.ctx, async (session) => {
    const scope = await knowledge.scopeOf(app.ctx, session.org_id, session.project_id);
    if (!(await knowledge.hasReachable(app.ctx, scope))) return null;
    return { instructions: DOCS_INSTRUCTIONS, mcpServers: [toolkitServer(app, session.id, DOCS_TOOLKIT)] };
  });
  mountToolkit<knowledge.Scope>(app, {
    ...DOCS_TOOLKIT,
    tools: DOCS_TOOLS,
    authorize: (sessionId) => knowledge.sessionScope(app.ctx, sessionId),
    call: (scope, tool, args) => callDocsTool(app.ctx, scope, tool, args),
  });

  // Memory: what was remembered is shown to every turn, an agent keeps it with a tool,
  // and a conversation that has gone quiet is reviewed for what else is worth keeping.
  memoryReview.start(app);
  registerTurnExtras(app.ctx, async (session) => {
    const owner = await memory.ownerOfSession(app.ctx, session);
    if (!(await memory.getSettings(app.ctx, owner)).enabled) return null;
    return {
      instructions: await memory.render(app.ctx, owner),
      mcpServers: [toolkitServer(app, session.id, MEMORY_TOOLKIT)],
    };
  });
  onTurnEnd(app.ctx, (turn) => memoryReview.arm(app.ctx, turn));
  mountToolkit<memory.Owner>(app, {
    ...MEMORY_TOOLKIT,
    tools: MEMORY_TOOLS,
    authorize: (sessionId) => authorizeMemory(app.ctx, sessionId),
    call: (owner, tool, args) => callMemoryTool(app.ctx, owner, tool, args),
  });
  registerDeviceLink(app);
}
