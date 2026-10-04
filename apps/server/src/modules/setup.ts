/**
 * What modules do once per server, beyond answering contract operations:
 * routes the contract cannot describe, and subscriptions to infrastructure.
 */
import type { FastifyInstance } from "fastify";
import { mountToolkit, toolkitServer } from "../infra/toolkit.ts";
import * as automations from "./automations/runner.ts";
import * as channelChat from "./channels/chat.ts";
import * as feishu from "./channels/feishu.ts";
import * as wecom from "./channels/wecom.ts";
import * as artifacts from "./files/artifacts.ts";
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
import * as teamChat from "./tasks/chat.ts";
import { TASK_TOOLKIT } from "./tasks/prompts.ts";
import * as tasks from "./tasks/service.ts";
import { LEAD_TOOLS } from "./tasks/tools.ts";

export async function setupModules(app: FastifyInstance): Promise<void> {
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

  // A conversation in a project with a team can hand work to it.
  registerTurnExtras(app.ctx, async (session) =>
    (await teamChat.available(app.ctx, session))
      ? {
          instructions: teamChat.CHAT_INSTRUCTIONS,
          mcpServers: [toolkitServer(app, session.id, teamChat.CHAT_TOOLKIT)],
        }
      : null,
  );
  mountToolkit<teamChat.ChatCaller>(app, {
    ...teamChat.CHAT_TOOLKIT,
    tools: teamChat.CHAT_TOOLS,
    authorize: (sessionId) => teamChat.authorize(app.ctx, sessionId),
    call: (caller, tool, args) => teamChat.callTool(app, caller, tool, args),
  });

  // Deliverables: an agent marks the files that are its result.
  registerTurnExtras(app.ctx, async (session) =>
    session.device_id
      ? {
          instructions: artifacts.ARTIFACT_INSTRUCTIONS,
          mcpServers: [toolkitServer(app, session.id, artifacts.ARTIFACT_TOOLKIT)],
        }
      : null,
  );
  mountToolkit<artifacts.Deliverer>(app, {
    ...artifacts.ARTIFACT_TOOLKIT,
    tools: artifacts.ARTIFACT_TOOLS,
    authorize: (sessionId) => artifacts.authorize(app.ctx, sessionId),
    call: (by, tool, args) => artifacts.callTool(app.ctx, by, tool, args),
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
  tasks.onTaskFinished(app.ctx, (taskId) => memoryReview.taskFinished(app.ctx, taskId));
  mountToolkit<memory.Owner>(app, {
    ...MEMORY_TOOLKIT,
    tools: MEMORY_TOOLS,
    authorize: (sessionId) => authorizeMemory(app.ctx, sessionId),
    call: (owner, tool, args) => callMemoryTool(app.ctx, owner, tool, args),
  });

  // Automations: the clock starts runs, and a turn ending tells a run how it went.
  automations.start(app);
  onTurnEnd(app.ctx, (turn) => automations.handleTurnEnd(app.ctx, turn));

  // Chat-app bots: a message in becomes a turn, and a turn ending answers in the chat.
  onTurnEnd(app.ctx, (turn) => channelChat.handleTurnEnd(app.ctx, turn));
  await feishu.start(app);
  await wecom.start(app);
  registerDeviceLink(app);
}
