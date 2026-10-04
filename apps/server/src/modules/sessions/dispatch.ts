/**
 * Running a turn. The server keeps no secrets in a session row: the model
 * credential, the agent's current instructions and the project's context are
 * resolved every time a turn is dispatched, then handed to the device.
 */
import {
  type Actor,
  type Attachment,
  type ApiProtocol as KernelProtocol,
  type McpServerConfig,
  Session,
  type SkillBundle,
  type UserMessage,
  managedCwd,
} from "@agent-base/protocol";
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { DeviceOfflineError } from "../../infra/device-hub.ts";
import { HttpError, conflict, notFound } from "../../infra/errors.ts";
import { orgChannel } from "../../infra/pubsub.ts";
import * as agents from "../agents/service.ts";
import * as audit from "../audit/service.ts";
import * as connectors from "../connectors/service.ts";
import * as projects from "../projects/service.ts";
import { type ApiProtocol, protocolFor } from "../providers/catalog.ts";
import * as providers from "../providers/service.ts";
import * as skills from "../skills/service.ts";
import * as repo from "./repo.ts";
import * as sessions from "./service.ts";
import type { StoredEventRow } from "./translate.ts";

const QUEUE_LIMIT = 20;
type Row = NonNullable<Awaited<ReturnType<typeof repo.byId>>>;
/** Delivers a message's files to the session's device and says where each landed. */
export type AttachmentSource = (session: Row) => Promise<Attachment[]>;

/** What another module adds to a session's turn: more to its instructions, more tool servers. */
export interface TurnExtras {
  instructions: string;
  mcpServers: McpServerConfig[];
}
type ExtrasProvider = (session: Row) => Promise<TurnExtras | null>;

/** A turn's final state, as other modules hear of it. */
export interface TurnEnd {
  id: string;
  session_id: string;
  status: string;
  assistant_message: string | null;
  error_message: unknown;
}
type TurnEndListener = (turn: TurnEnd) => Promise<void>;

/** What other modules hooked into this server's sessions. Kept per server: a process may run several. */
type IdleListener = (sessionId: string) => Promise<void>;
const hooks = new WeakMap<Ctx, { extras: ExtrasProvider[]; turnEnd: TurnEndListener[]; idle: IdleListener[] }>();
function hooksOf(ctx: Ctx) {
  let mine = hooks.get(ctx);
  if (!mine) hooks.set(ctx, (mine = { extras: [], turnEnd: [], idle: [] }));
  return mine;
}

/**
 * Hear when a session becomes free to take a turn. A turn's final state and
 * the session going idle are reported separately and in either order, so
 * anything that wants to start the next turn listens for this, not for the end.
 */
export const onSessionIdle = (ctx: Ctx, listener: IdleListener): void => void hooksOf(ctx).idle.push(listener);
export function sessionIdle(ctx: Ctx, sessionId: string): void {
  for (const listener of hooksOf(ctx).idle)
    void listener(sessionId).catch((err: unknown) => ctx.log(err, `session ${sessionId}: an idle listener failed`));
}

/** Have every turn ask `provider` what it adds. (Tasks give their lead a toolkit and a protocol this way.) */
export const registerTurnExtras = (ctx: Ctx, provider: ExtrasProvider): void => void hooksOf(ctx).extras.push(provider);
export const onTurnEnd = (ctx: Ctx, listener: TurnEndListener): void => void hooksOf(ctx).turnEnd.push(listener);

/** Tell the listeners; one that fails is logged and does not stop the others. */
export function turnEnded(ctx: Ctx, turn: TurnEnd): void {
  for (const listener of hooksOf(ctx).turnEnd)
    void listener(turn).catch((err: unknown) => ctx.log(err, `turn ${turn.id}: a turn-end listener failed`));
}

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

  const extras = (await Promise.all(hooksOf(ctx).extras.map((provide) => provide(row)))).flatMap((e) => (e ? [e] : []));
  // A deployed agent is a live reference: the turn uses its instructions as they are now.
  const instructions = [
    agent?.instructions ?? "",
    project?.instructions ? `## Project: ${project.name}\n${project.instructions}` : "",
    ...extras.map((extra) => extra.instructions),
  ]
    .filter(Boolean)
    .join("\n\n");
  // …and its equipment as it is now: the current version of each skill it names.
  const skillBundles = await skills.bundlesFor(ctx, row.org_id, agent?.skills ?? []);
  const equipped = skillBundles.map((bundle) => bundle.slug);
  const mcpServers = [
    ...(await connectors.serversFor(ctx, row.org_id, agent?.connector_types ?? [])),
    ...extras.flatMap((extra) => extra.mcpServers),
  ];
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
    mcp_servers: mcpServers,
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

/**
 * Ask a session's model one question, outside the conversation. Runtimes are on
 * devices — and so is the login a subscription session uses — so the question
 * is put to the session's device, which answers it with the session's own
 * runtime and credentials and keeps nothing. Null when there is no device to ask.
 */
export async function askOnDevice(ctx: Ctx, sessionId: string, prompt: string): Promise<string | null> {
  const row = await repo.byId(ctx.db, sessionId);
  if (!row?.device_id) return null;
  const channel = row.provider_id ? await providers.credentialsForSession(ctx, row.org_id, row.provider_id) : null;
  const protocol = channel ? protocolFor(row.runtime_provider, channel.protocols as ApiProtocol[]) : null;
  if (row.provider_id && !protocol) return null;
  const session = Session.parse({
    id: crypto.randomUUID(),
    // One answer, no tools worth waiting on: anything that would need approval is simply not approved.
    agent_config: {
      id: "",
      name: "aside",
      model: row.model,
      runtime_provider: row.runtime_provider,
      instructions: "",
      skills: [],
      permission_mode: "default",
      max_turns: 1,
    },
    cwd: managedCwd("asides"),
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
    instructions: "",
    permission_mode: "default",
    status: "running",
  });
  const owner = { user_id: row.owner_id, name: await repo.userName(ctx.db, row.owner_id) };
  try {
    const answer = (await ctx.hub.call(
      row.device_id,
      "session.ask",
      { session, prompt, timeout_ms: 120_000 },
      owner,
      150_000,
    )) as { text: string };
    return answer.text;
  } catch (err) {
    // The device is away or could not answer: there is simply no answer this time.
    if (err instanceof HttpError) return null;
    throw err;
  }
}

/** What a conversation is called until someone names it: the start of its first message. */
const titleFrom = (text: string): string => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
};

/**
 * Run a turn on a session this caller has just claimed. Whatever goes wrong
 * before the device accepts it leaves nothing behind: the turn's row is removed
 * and the session goes back to the status it had.
 */
async function startClaimed(
  ctx: Ctx,
  row: Row,
  previous: string,
  text: string,
  actor: Actor,
  attach: AttachmentSource = async () => [],
): Promise<string> {
  const messageId = crypto.randomUUID();
  try {
    if (!row.device_id) throw conflict("the device this session ran on was removed", "device_removed");
    const { session, skillBundles } = await kernelSession(ctx, row);
    // Files the message carries are put on the device first; the turn is told where they are.
    const userMessage: UserMessage = { text, attachments: await attach(row), additional_context: "" };
    await repo.insertMessage(ctx.db, {
      id: messageId,
      session_id: row.id,
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
    await repo.setStatus(ctx.db, row.id, previous);
    throw err;
  }
  await repo.noteUserMessage(ctx.db, row.id, text, titleFrom(text));
  await ctx.pubsub.publish(orgChannel(row.org_id), {
    type: "session.updated",
    session_id: row.id,
    status: "running",
    actor_id: actor.user_id,
  });
  return messageId;
}

/**
 * Start a turn on the session's device and return its message id. Throws 409
 * `session_busy` when a turn is already running and 503 when the device is
 * offline.
 */
export async function dispatchTurn(
  ctx: Ctx,
  sessionId: string,
  text: string,
  actor: Actor,
  attach?: AttachmentSource,
): Promise<string> {
  const row = await repo.byId(ctx.db, sessionId);
  if (!row) throw notFound("session");
  const previous = await repo.claimForTurn(ctx.db, sessionId);
  if (!previous) throw conflict("this session is already running a turn", "session_busy");
  return startClaimed(ctx, row, previous, text, actor, attach);
}

export async function send(
  ctx: Ctx,
  auth: Auth,
  id: string,
  prompt: string,
  attach?: AttachmentSource,
): Promise<Schema<"SessionDetail">> {
  await sessions.drive(ctx, auth, id);
  // Sending by hand is the "go on" that resumes a queue paused by an interrupt.
  await repo.setQueuePaused(ctx.db, id, false);
  await dispatchTurn(ctx, id, prompt, { user_id: auth.userId, name: auth.name }, attach);
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
    turnEnded(ctx, {
      id: messageId,
      session_id: sessionId,
      status: "errored",
      assistant_message: null,
      error_message: { message: reason },
    });
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
 *
 * The session is claimed BEFORE an input is taken off the queue. Several things
 * ask for a drain at the same moment (a turn's final state, the session going
 * idle, someone queueing); claiming first means only one of them gets to take
 * the head of the queue, so inputs go out in order.
 */
export async function drain(ctx: Ctx, sessionId: string): Promise<boolean> {
  const row = await repo.byId(ctx.db, sessionId);
  if (!row || row.queue_paused) return false;
  // Nothing queued: do not claim at all, or a message sent at that instant would find the session "busy".
  if ((await repo.listQueue(ctx.db, sessionId)).length === 0) return false;
  const previous = await repo.claimForTurn(ctx.db, sessionId);
  if (!previous) return false;
  const next = await repo.takeNextQueued(ctx.db, sessionId);
  if (!next) {
    await repo.setStatus(ctx.db, sessionId, previous);
    return false;
  }
  try {
    const name = await repo.userName(ctx.db, next.actor_id);
    await startClaimed(ctx, row, previous, next.text, { user_id: next.actor_id, name });
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

/** "Go on": queued input held back by an interrupt starts flowing again. */
export async function resumeQueue(ctx: Ctx, auth: Auth, id: string): Promise<Queue> {
  await sessions.drive(ctx, auth, id);
  await repo.setQueuePaused(ctx.db, id, false);
  await drain(ctx, id);
  return presentQueue(ctx, id);
}

/**
 * "Do this one now": the queued input jumps to the front and, if a turn is
 * running, that turn is stopped to make way — what it had not finished is lost.
 */
export async function steer(ctx: Ctx, auth: Auth, id: string, queueId: string): Promise<Queue> {
  const { row } = await sessions.drive(ctx, auth, id);
  if (!(await repo.promoteQueued(ctx.db, id, queueId))) throw notFound("queued input");
  await repo.setQueuePaused(ctx.db, id, false);
  if (row.status === "running" && row.device_id) {
    // The turn ending is what sends the promoted input.
    await ctx.hub
      .call(row.device_id, "session.interrupt", { session_id: id }, { user_id: auth.userId, name: auth.name })
      .catch(async (err: unknown) => {
        if (!(err instanceof DeviceOfflineError)) throw err;
        await closeStrandedTurn(ctx, id, "the device went offline mid-turn");
      });
  } else {
    await drain(ctx, id);
  }
  return presentQueue(ctx, id);
}

// -- Approvals --

const DECISION_TTL_S = 24 * 60 * 60;

/**
 * Answer a `requires_action` the agent is waiting on. Saying the same thing
 * twice is harmless; a different decision for the same request is refused —
 * in a shared session two people may answer at once, and the first one stands.
 */
export async function submitAction(
  ctx: Ctx,
  auth: Auth,
  id: string,
  input: Schema<"SessionActionRequest">,
): Promise<Schema<"SessionActionResponse">> {
  const { row } = await sessions.drive(ctx, auth, id);
  if (!row.device_id) throw conflict("the device this session ran on was removed", "device_removed");
  const key = `action:${id}:${input.pending_id}`;
  const mine = JSON.stringify({ decision: input.decision, accepted_at: Date.now() });
  // The first decision to arrive claims the request.
  const claimed = await ctx.redis.set(key, mine, "EX", DECISION_TTL_S, "NX");
  const standing = JSON.parse((claimed ? mine : await ctx.redis.get(key)) ?? mine) as {
    decision: Schema<"SessionActionRequest">["decision"];
    accepted_at: number;
  };
  const answer = { session_id: id, pending_id: input.pending_id, ...standing, rule_id: null };
  if (!claimed) {
    if (standing.decision !== input.decision)
      throw conflict(`this request was already answered: ${standing.decision}`, "already_resolved");
    return { ...answer, idempotent: true };
  }
  try {
    await ctx.hub.call(
      row.device_id,
      "session.action",
      {
        session_id: id,
        action: {
          pending_id: input.pending_id,
          decision: input.decision,
          message: input.message ?? null,
          answers: input.answers ?? null,
          modified_input: input.modified_input ?? null,
        },
      },
      { user_id: auth.userId, name: auth.name },
    );
  } catch (err) {
    await ctx.redis.del(key);
    // The device no longer has it: it expired, was interrupted, or was answered there.
    if (err instanceof HttpError && err.status === 404)
      throw new HttpError(410, "action_expired", "that request is no longer waiting for an answer");
    throw err;
  }
  await audit.record(
    ctx.db,
    auth,
    "session.action",
    { type: "session", id },
    { pending_id: input.pending_id, decision: input.decision },
  );
  return { ...answer, idempotent: false };
}
