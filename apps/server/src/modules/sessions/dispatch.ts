/**
 * Running a turn. The server keeps no secrets in a session row: the model
 * credential, the agent's current instructions and the project's context are
 * resolved every time a turn is dispatched, then handed to the device.
 */
import {
  type Actor,
  type ApiProtocol as KernelProtocol,
  Session,
  type SkillBundle,
  type UserMessage,
} from "@agent-base/protocol";
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { DeviceOfflineError } from "../../infra/device-hub.ts";
import { conflict, notFound } from "../../infra/errors.ts";
import { orgChannel } from "../../infra/pubsub.ts";
import * as agents from "../agents/service.ts";
import * as projects from "../projects/service.ts";
import { type ApiProtocol, protocolFor } from "../providers/catalog.ts";
import * as providers from "../providers/service.ts";
import * as skills from "../skills/service.ts";
import * as repo from "./repo.ts";
import * as sessions from "./service.ts";
import type { StoredEventRow } from "./translate.ts";

const QUEUE_LIMIT = 20;
type Row = NonNullable<Awaited<ReturnType<typeof repo.byId>>>;

/** The session as the kernel on the device needs it for this turn, and the skill packages its agent carries. */
async function kernelSession(ctx: Ctx, row: Row): Promise<{ session: Session; skillBundles: SkillBundle[] }> {
  const [agent, project, channel] = await Promise.all([
    row.agent_id ? agents.forSession(ctx, row.agent_id) : null,
    projects.contextForSession(ctx, row.project_id),
    row.provider_id ? providers.credentialsForSession(ctx, row.org_id, row.provider_id) : null,
  ]);
  if (row.provider_id && !channel)
    throw conflict("this session's model channel was removed or has no key", "provider_unavailable");
  const protocol = channel ? protocolFor(row.runtime_provider, channel.protocols as ApiProtocol[]) : null;
  if (channel && !protocol)
    throw conflict("this session's model channel can no longer drive its runtime", "protocol_mismatch");

  // A deployed agent is a live reference: the turn uses its instructions as they are now.
  const instructions = [
    agent?.instructions ?? "",
    project?.instructions ? `## Project: ${project.name}\n${project.instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  // …and its equipment as it is now: the current version of each skill it names.
  const skillBundles = await skills.bundlesFor(ctx, row.org_id, agent?.skills ?? []);
  const equipped = skillBundles.map((bundle) => bundle.slug);
  const session = Session.parse({
    id: row.id,
    agent_config: {
      id: agent?.id ?? "",
      name: agent?.name ?? "Assistant",
      model: row.model,
      runtime_provider: row.runtime_provider,
      instructions,
      skills: equipped,
      permission_mode: row.permission_mode,
      effort: row.effort,
      metadata: agent ? { slug: agent.slug } : {},
    },
    cwd: row.cwd,
    runtime_provider: row.runtime_provider,
    user_id: row.owner_id,
    model: row.model,
    model_provider:
      channel && protocol
        ? {
            api_key: channel.api_key,
            base_url: channel.base_url,
            api_protocol: protocol.replace("-", "_") as KernelProtocol,
          }
        : null,
    model_settings: row.effort ? { effort: row.effort } : null,
    instructions,
    skills: equipped,
    permission_mode: row.permission_mode,
    mode: row.mode,
    status: "running",
    metadata: row.metadata,
    runtime_session_id: row.runtime_session_id,
    todos: row.todos,
    created_at: row.created_at.getTime(),
  });
  return { session, skillBundles };
}

/** What a conversation is called until someone names it: the start of its first message. */
const titleFrom = (text: string): string => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
};

/**
 * Start a turn on the session's device and return its message id. Throws 409
 * `session_busy` when a turn is already running and 503 when the device is
 * offline; a dispatch that fails leaves nothing behind.
 */
export async function dispatchTurn(ctx: Ctx, sessionId: string, text: string, actor: Actor): Promise<string> {
  const row = await repo.byId(ctx.db, sessionId);
  if (!row) throw notFound("session");
  if (!row.device_id) throw conflict("the device this session ran on was removed", "device_removed");
  const { session, skillBundles } = await kernelSession(ctx, row);
  const userMessage: UserMessage = { text, attachments: [], additional_context: "" };

  if (!(await repo.claimForTurn(ctx.db, sessionId, text, titleFrom(text))))
    throw conflict("this session is already running a turn", "session_busy");
  const messageId = crypto.randomUUID();
  try {
    await repo.insertMessage(ctx.db, {
      id: messageId,
      session_id: sessionId,
      actor_id: actor.user_id,
      user_message: userMessage,
      started_at: Date.now(),
    });
    await ctx.hub.call(
      row.device_id,
      "session.run",
      { session, message_id: messageId, user_message: userMessage, skill_bundles: skillBundles },
      actor,
    );
  } catch (err) {
    await repo.deleteMessage(ctx.db, messageId);
    await repo.setStatus(ctx.db, sessionId, row.status === "running" ? "idle" : row.status);
    throw err;
  }
  await ctx.pubsub.publish(orgChannel(row.org_id), {
    type: "session.updated",
    session_id: sessionId,
    status: "running",
    actor_id: actor.user_id,
  });
  return messageId;
}

export async function send(ctx: Ctx, auth: Auth, id: string, prompt: string): Promise<Schema<"SessionDetail">> {
  await sessions.drive(ctx, auth, id);
  // Sending by hand is the "go on" that resumes a queue paused by an interrupt.
  await repo.setQueuePaused(ctx.db, id, false);
  await dispatchTurn(ctx, id, prompt, { user_id: auth.userId, name: auth.name });
  return sessions.get(ctx, auth, id);
}

/**
 * A device that went away mid-turn cannot report the turn's end. Close the turn
 * on its behalf, in the event log too, so everyone watching sees it stop.
 */
export async function closeStrandedTurn(ctx: Ctx, sessionId: string, reason: string): Promise<void> {
  const row = await repo.byId(ctx.db, sessionId);
  if (!row) return;
  const error = { type: "error", category: "interrupted", retry_status: "terminal", message: reason };
  for (const messageId of await repo.failRunningMessages(ctx.db, sessionId, { message: reason })) {
    for (const [type, data] of [
      ["session_error", { message: reason, category: "interrupted" }],
      ["session_idle", { stop_reason: error }],
    ] as const) {
      const stored = await repo.appendEvent(ctx.db, {
        session_id: sessionId,
        message_id: messageId,
        type,
        data: { ...data, message_id: messageId },
        ts: Date.now(),
        event_uid: crypto.randomUUID(),
      });
      if (stored) await announce(ctx, row.org_id, sessionId, stored);
    }
  }
  if (row.device_id) await repo.applyPatch(ctx.db, row.device_id, sessionId, { status: "idle", stop_reason: error });
  await ctx.pubsub.publish(orgChannel(row.org_id), { type: "session.updated", session_id: sessionId, status: "idle" });
}

export const sessionChannel = (sessionId: string): string => `sess:${sessionId}`;

/**
 * Tell everyone following: the session's own stream gets every event; the
 * organization's channel gets the ones that mark a run starting or ending,
 * which is what keeps lists of running work current.
 */
export async function announce(ctx: Ctx, orgId: string, sessionId: string, stored: StoredEventRow): Promise<void> {
  await ctx.pubsub.publish(sessionChannel(sessionId), stored);
  if ((repo.LIFECYCLE_TYPES as readonly string[]).includes(stored.type))
    await ctx.pubsub.publish(orgChannel(orgId), { type: "session.event", session_id: sessionId, event: stored });
}

/** Stop the running turn. Queued input then waits until someone sends or resumes. */
export async function interrupt(ctx: Ctx, auth: Auth, id: string): Promise<Schema<"SessionDetail">> {
  const { row } = await sessions.drive(ctx, auth, id);
  await repo.setQueuePaused(ctx.db, id, true);
  if (row.status === "running" && row.device_id) {
    try {
      await ctx.hub.call(
        row.device_id,
        "session.interrupt",
        { session_id: id },
        { user_id: auth.userId, name: auth.name },
      );
    } catch (err) {
      if (!(err instanceof DeviceOfflineError)) throw err;
      await closeStrandedTurn(ctx, id, "the device went offline mid-turn");
    }
  }
  return sessions.get(ctx, auth, id);
}

// -- Input typed while a turn is running --

type Queue = Schema<"QueuedInputList">;

async function presentQueue(ctx: Ctx, sessionId: string): Promise<Queue> {
  const [row, items] = await Promise.all([repo.byId(ctx.db, sessionId), repo.listQueue(ctx.db, sessionId)]);
  return {
    session_id: sessionId,
    paused: row?.queue_paused ?? false,
    draining: false,
    dispatching: null,
    items: items.map((item, index) => ({
      id: item.id,
      status: "queued",
      position: index,
      text: item.text,
      attachment_count: 0,
      provider_id: null,
      model_id: null,
      error_message: null,
      created_at: item.created_at.getTime(),
      updated_at: item.updated_at?.getTime() ?? null,
    })),
  };
}

export async function listQueue(ctx: Ctx, auth: Auth, id: string): Promise<Queue> {
  await sessions.access(ctx, auth, id);
  return presentQueue(ctx, id);
}

/**
 * Send the next queued input of an idle session, as the person who queued it.
 * Returns false when there was nothing to send, the queue is paused, or the
 * session could not take it (busy, device offline) — then it stays queued.
 */
export async function drain(ctx: Ctx, sessionId: string): Promise<boolean> {
  const row = await repo.byId(ctx.db, sessionId);
  if (!row || row.queue_paused || row.status === "running") return false;
  const next = await repo.takeNextQueued(ctx.db, sessionId);
  if (!next) return false;
  try {
    const name = await repo.userName(ctx.db, next.actor_id);
    await dispatchTurn(ctx, sessionId, next.text, { user_id: next.actor_id, name });
    return true;
  } catch {
    await repo.restoreQueued(ctx.db, { ...next, session_id: sessionId });
    return false;
  }
}

export async function enqueue(ctx: Ctx, auth: Auth, id: string, prompt: string): Promise<Queue> {
  await sessions.drive(ctx, auth, id);
  if (!prompt.trim()) throw conflict("there is nothing to queue", "empty_input");
  if ((await repo.listQueue(ctx.db, id)).length >= QUEUE_LIMIT)
    throw conflict(`a session holds at most ${QUEUE_LIMIT} queued messages`, "queue_full");
  await repo.enqueue(ctx.db, { id: crypto.randomUUID(), session_id: id, actor_id: auth.userId, text: prompt });
  // Nothing running: it goes out at once.
  await drain(ctx, id);
  return presentQueue(ctx, id);
}

export async function editQueued(ctx: Ctx, auth: Auth, id: string, queueId: string, prompt: string): Promise<Queue> {
  await sessions.drive(ctx, auth, id);
  if (!(await repo.editQueued(ctx.db, id, queueId, prompt))) throw notFound("queued input");
  return presentQueue(ctx, id);
}

export async function deleteQueued(ctx: Ctx, auth: Auth, id: string, queueId: string): Promise<Queue> {
  await sessions.drive(ctx, auth, id);
  if (!(await repo.deleteQueued(ctx.db, id, queueId))) throw notFound("queued input");
  return presentQueue(ctx, id);
}
