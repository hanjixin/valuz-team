/**
 * Sessions — created on the server, run on a device, watched and driven by
 * whoever has access. Who that is flows from three places: the session itself
 * (its owner, and anyone it is shared with), its project (`edit` there means
 * a teammate may drive it, `view`/`use` that they may watch), and its device
 * (`control` there means remote control of everything running on it).
 */
import { type RuntimeProvider, managedCwd } from "@agent-base/protocol";
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../../infra/errors.ts";
import * as members from "../agents/members.ts";
import * as audit from "../audit/service.ts";
import * as devices from "../devices/service.ts";
import * as projects from "../projects/service.ts";
import { type ApiProtocol, protocolFor } from "../providers/catalog.ts";
import * as providers from "../providers/service.ts";
import * as sharing from "../sharing/service.ts";
import * as repo from "./repo.ts";

sharing.registerShareable("session", "sessions");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The project id the web app sends for a quick chat that belongs to no project. */
const CHAT_PROJECT = "chat-default";

type Detail = Schema<"SessionDetail">;
type Row = Omit<repo.SessionRow, "permission">;

const strongest = (a: sharing.Permission | null, b: sharing.Permission | null): sharing.Permission | null =>
  (a ? sharing.permissionRank(a) : 0) >= (b ? sharing.permissionRank(b) : 0) ? a : b;

export function present(row: Row, permission: sharing.Permission, totalTokens = 0): Detail {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    // The kernel's "terminated" is the web app's "archived".
    status: (row.status === "terminated" ? "archived" : row.status) as Detail["status"],
    origin: row.origin as Detail["origin"],
    last_user_message_text: row.last_user_message_text,
    locked_model_id: row.model || null,
    // A session with no channel runs on its device's own login: the subscription channel, as the app knows it.
    locked_provider_id: row.provider_id ?? providers.subscriptionFor(row.runtime_provider)?.id ?? null,
    updated_at: row.updated_at.getTime(),
    created_at: row.created_at.getTime(),
    runtime_provider: row.runtime_provider as Detail["runtime_provider"],
    permission_mode: row.permission_mode as Detail["permission_mode"],
    effort: row.effort as Detail["effort"],
    mode: row.mode as Detail["mode"],
    task_id: (row.metadata as { valuz?: { task?: { task_id?: string } } }).valuz?.task?.task_id ?? null,
    worktree: null,
    forked_from_session_id: null,
    background: false,
    todos: (row.todos as Detail["todos"]) ?? null,
    instructions: null,
    agent_slug: row.agent_slug,
    total_tokens: totalTokens,
    total_cost_usd: 0,
    device_id: row.device_id,
    owner_id: row.owner_id,
    permission,
  };
}

/** The session and what the caller may do with it. 404 when they may not even see it. */
export async function access(
  ctx: Ctx,
  auth: Auth,
  id: string,
): Promise<{ row: repo.SessionRow; permission: sharing.Permission }> {
  const row = UUID.test(id) ? await repo.find(ctx.db, auth, id) : undefined;
  if (!row) throw notFound("session");
  let permission = row.permission;
  if (permission !== "admin") {
    const project = await sharing.getPermission(ctx.db, auth, "project", row.project_id);
    if (project) permission = strongest(permission, sharing.permissionAtLeast(project, "edit") ? "control" : "view");
    const device = row.device_id ? await sharing.getPermission(ctx.db, auth, "device", row.device_id) : null;
    if (device && sharing.permissionAtLeast(device, "control")) permission = strongest(permission, "control");
  }
  if (!permission) throw notFound("session");
  return { row, permission };
}

/** A session as background work sees it: there is no caller, so no permission to check. */
export const byId = async (ctx: Ctx, id: string) => (UUID.test(id) ? repo.byId(ctx.db, id) : undefined);

/** What was said in the turns that finished after `since` (epoch ms), oldest first. */
export async function transcriptSince(
  ctx: Ctx,
  id: string,
  since: number,
): Promise<{ user: string; assistant: string; endedAt: number }[]> {
  const turns = await repo.completedTurnsSince(ctx.db, id, since, 50);
  return turns.map((turn) => ({
    user: String((turn.user_message as { text?: unknown }).text ?? ""),
    assistant: turn.assistant_message ?? "",
    endedAt: Number(turn.ended_at),
  }));
}

/** How many turns finished after `since` (epoch ms). */
export const turnsSince = async (ctx: Ctx, id: string, since: number): Promise<number> =>
  (await repo.completedTurnsSince(ctx.db, id, since, 500)).length;

/** As `access`, for someone who is going to send, interrupt or queue. */
export async function drive(ctx: Ctx, auth: Auth, id: string) {
  const found = await access(ctx, auth, id);
  if (!sharing.permissionAtLeast(found.permission, "control"))
    throw forbidden('driving this session needs "control" permission');
  return found;
}

export async function get(ctx: Ctx, auth: Auth, id: string): Promise<Detail> {
  const { row, permission } = await access(ctx, auth, id);
  return present(row, permission, await repo.usageTotals(ctx.db, id));
}

export async function list(ctx: Ctx, auth: Auth, filter: { projectId?: string; q?: string }): Promise<Detail[]> {
  const visible = await projects.list(ctx, auth);
  const rows = await repo.list(
    ctx.db,
    auth,
    visible.map((project) => project.id),
    filter,
  );
  const editable = new Set(
    visible.filter((p) => sharing.permissionAtLeast(p.permission ?? "view", "edit")).map((p) => p.id),
  );
  return rows.map((row) => present(row, row.permission ?? (editable.has(row.project_id) ? "control" : "view")));
}

/** A page of the conversations the caller can see, for a feed that interleaves them with other things. */
export const recent = (
  ctx: Ctx,
  auth: Auth,
  projectIds: string[],
  page: { projectId?: string; before?: repo.Before; limit: number; origins: ("user" | "automation")[] },
) => repo.recent(ctx.db, auth, projectIds, page);

/** The device a new session runs on: the one named, the project's, else the caller's own that is online. */
export const deviceFor = (ctx: Ctx, auth: Auth, wanted: string | null | undefined, projectDevice: string | null) =>
  chooseDevice(ctx, auth, wanted, projectDevice);

/**
 * What a session runs on. A channel named for it (by the request, or by its
 * agent) is used or refused; with none named, the member's default is used when
 * it can drive the runtime. The Claude and Codex runtimes need no channel at
 * all — the device's own login will do — so for them "no channel" is an answer,
 * and a subscription channel is just a way of saying so.
 */
async function chooseModel(
  ctx: Ctx,
  auth: Auth,
  wanted: { providerId?: string | null; runtime?: string | null; model?: string | null; who: string },
): Promise<{ providerId: string | null; runtime: string; model: string }> {
  const defaults = await providers.getDefaults(ctx, auth);
  const named = providers.subscriptionOf(wanted.providerId);
  const runtime = wanted.runtime ?? named?.runtime ?? defaults.default_runtime;
  const mismatch = () =>
    badRequest(`${wanted.who}'s model channel cannot drive the ${runtime} runtime`, "protocol_mismatch");

  if (named) {
    if (named.runtime !== runtime) throw mismatch();
    return { providerId: null, runtime, model: wanted.model || named.default_model };
  }
  if (wanted.providerId) {
    const channel = await providers.describe(ctx, auth, wanted.providerId);
    if (!protocolFor(runtime, channel.protocols as ApiProtocol[])) throw mismatch();
    return { providerId: wanted.providerId, runtime, model: wanted.model || channel.default_model || "" };
  }
  // Nothing named: the member's default, if it is a channel that can drive this runtime.
  const usual = defaults.default_provider_id;
  const channel = usual && !providers.subscriptionOf(usual) ? await providers.describe(ctx, auth, usual) : null;
  if (channel && protocolFor(runtime, channel.protocols as ApiProtocol[]))
    return { providerId: usual, runtime, model: wanted.model || channel.default_model || defaults.default_model || "" };
  const login = providers.subscriptionFor(runtime);
  if (!login)
    throw badRequest(`${wanted.who} needs a model channel: add one in Settings → Models`, "provider_required");
  const mine = providers.subscriptionOf(usual)?.id === login.id ? defaults.default_model : null;
  return { providerId: null, runtime, model: wanted.model || mine || login.default_model };
}

async function chooseDevice(ctx: Ctx, auth: Auth, wanted: string | null | undefined, projectDevice: string | null) {
  const named = wanted ?? projectDevice;
  if (named) return (await devices.get(ctx, auth, named, "use")).id;
  const usable = (await devices.list(ctx, auth)).filter((d) =>
    sharing.permissionAtLeast(d.permission ?? "view", "use"),
  );
  const rank = (d: (typeof usable)[number]) => (d.online ? 2 : 0) + (d.owner_id === auth.userId ? 1 : 0);
  const best = usable.sort((a, b) => rank(b) - rank(a))[0];
  if (!best)
    throw conflict(
      "a session runs on a device, and none is linked yet — run agent-base-host on a computer",
      "no_device",
    );
  return best.id;
}

export async function create(
  ctx: Ctx,
  auth: Auth,
  input: Schema<"SessionCreateRequest">,
  /** Set when something other than a person starts the session, and says what for. */
  started?: { origin: "automation" | "user"; metadata: Record<string, unknown> },
): Promise<Detail> {
  const quickChat = input.project_id === CHAT_PROJECT;
  const existing = quickChat ? null : await projects.require(ctx, auth, input.project_id, "use");
  const deviceId = await chooseDevice(ctx, auth, input.device_id, existing?.device_id ?? null);
  if (existing?.root_path && existing.device_id !== deviceId)
    throw badRequest("this project's folder is on another device; its sessions run there", "wrong_device");

  const agent = input.agent_slug
    ? await members.resolveForSession(ctx, auth, existing?.id ?? null, input.agent_slug)
    : null;
  const chosen = await chooseModel(ctx, auth, {
    providerId: input.provider_id ?? agent?.provider_id,
    runtime: input.runtime_id ?? agent?.runtime,
    model: input.model_id || agent?.model,
    who: "this session",
  });

  const id = crypto.randomUUID();
  const project = existing ?? (await projects.createChat(ctx, auth, deviceId));
  await repo.insert(ctx.db, {
    id,
    org_id: auth.orgId,
    owner_id: auth.userId,
    project_id: project.id,
    device_id: deviceId,
    agent_id: agent?.id ?? null,
    agent_slug: agent ? (input.agent_slug ?? null) : null,
    provider_id: chosen.providerId,
    name: input.title?.trim() || null,
    runtime_provider: chosen.runtime,
    model: chosen.model,
    // A project without a folder of its own works in one the device manages; so does every quick chat.
    cwd: project.root_path ?? managedCwd(quickChat ? `chat-${id}` : `project-${project.id}`),
    effort: input.effort ?? agent?.effort ?? null,
    permission_mode: input.permission_mode ?? agent?.permission_mode ?? "full_access",
    ...(started ?? {}),
  });
  await audit.record(ctx.db, auth, "session.create", { type: "session", id }, { project_id: project.id });
  return get(ctx, auth, id);
}

export async function rename(ctx: Ctx, auth: Auth, id: string, name: string): Promise<Detail> {
  await drive(ctx, auth, id);
  if (!name.trim()) throw badRequest("a session needs a name");
  await repo.rename(ctx.db, id, name.trim());
  return get(ctx, auth, id);
}

/** Deleting takes the conversation with it; a quick chat's own project goes too. */
export async function remove(ctx: Ctx, auth: Auth, id: string): Promise<void> {
  const { row, permission } = await access(ctx, auth, id);
  if (permission !== "admin") throw forbidden("only the session's owner or an organization admin can delete it");
  if (row.status === "running") throw conflict("interrupt the session before deleting it", "session_busy");
  await ctx.db.transaction().execute(async (tx) => {
    await sharing.revokeForResource(tx, "session", id);
    await repo.remove(tx, id);
    await audit.record(tx, auth, "session.delete", { type: "session", id });
  });
  if (row.device_id) {
    // Best effort: let the device drop what it kept for the session.
    void ctx.hub
      .call(row.device_id, "session.close", { session_id: id }, { user_id: auth.userId, name: auth.name })
      .catch(() => undefined);
  }
}

/**
 * Fork: a new session that starts from this one's conversation — all of it, or
 * up to one of its turns — and then goes its own way. The source is never
 * changed. The thread itself lives on the device, so the device branches it
 * first; if it cannot, nothing is created.
 */
export async function fork(ctx: Ctx, auth: Auth, id: string, messageId?: string | null): Promise<Detail> {
  const { row } = await drive(ctx, auth, id);
  if (row.runtime_provider === "codex")
    throw new HttpError(422, "fork_unsupported", "the Codex runtime cannot fork a conversation");
  if (!row.device_id) throw conflict("the device this session ran on was removed", "device_removed");
  if (!row.runtime_session_id) throw conflict("this session has no conversation to fork yet", "nothing_to_fork");
  await devices.get(ctx, auth, row.device_id, "use");

  let anchor: Record<string, unknown> | null = null;
  let through: number | null = null;
  if (messageId) {
    const message = UUID.test(messageId) ? await repo.findMessage(ctx.db, id, messageId) : undefined;
    if (!message) throw notFound("message");
    anchor = (message.metadata["runtime_native"] as Record<string, unknown> | undefined) ?? null;
    if (message.status !== "completed" || !anchor)
      throw conflict(
        "that turn cannot be forked from: it did not finish, or predates fork points",
        "fork_anchor_invalid",
      );
    through = Number(message.started_at);
  } else if (row.status === "running") {
    throw conflict("wait for the running turn to finish before forking", "session_busy");
  }

  const forkId = crypto.randomUUID();
  const actor = { user_id: auth.userId, name: auth.name };
  const branched = (await ctx.hub.call(
    row.device_id,
    "session.fork",
    { source_session_id: id, session_id: forkId, runtime_provider: row.runtime_provider as RuntimeProvider, anchor },
    actor,
  )) as { runtime_session_id: string | null };
  // A runtime that branches at the fork's first turn is told then where to branch from.
  const lazy = { valuz: { fork: { session_id: id, native_session_id: row.runtime_session_id, anchor } } };
  const quickChat = (await projects.contextForSession(ctx, row.project_id))?.kind === "chat";
  const ownProject = quickChat ? (await projects.createChat(ctx, auth, row.device_id)).id : null;
  await ctx.db.transaction().execute(async (tx) => {
    await repo.insertFork(
      tx,
      id,
      {
        id: forkId,
        owner_id: auth.userId,
        project_id: ownProject,
        name: `${row.name ?? "对话"}（分叉）`,
        metadata: branched.runtime_session_id ? {} : lazy,
        runtime_session_id: branched.runtime_session_id,
      },
      through,
    );
    await audit.record(tx, auth, "session.fork", { type: "session", id: forkId }, { source: id });
  });
  return get(ctx, auth, forkId);
}

/** What each runtime can be asked to do. The native runtime neither reviews tool calls itself nor plans. */
const SUPPORTS: Record<string, { modes: string[]; permissionModes: string[] }> = {
  claude_agent: { modes: ["default", "plan", "goal"], permissionModes: ["default", "auto_review", "full_access"] },
  codex: { modes: ["default", "plan", "goal"], permissionModes: ["default", "auto_review", "full_access"] },
  deepagents: { modes: ["default"], permissionModes: ["default", "full_access"] },
};

/**
 * Change how a session runs — its approval mode, working mode, or reasoning
 * effort. The session's row is what each turn is built from, so the change
 * takes effect on the next message.
 */
export async function setControls(
  ctx: Ctx,
  auth: Auth,
  id: string,
  controls: { permission_mode?: string; mode?: string; effort?: string | null },
): Promise<Detail> {
  const { row } = await drive(ctx, auth, id);
  const supported = SUPPORTS[row.runtime_provider];
  if (controls.permission_mode && !supported?.permissionModes.includes(controls.permission_mode))
    throw badRequest(
      `the ${row.runtime_provider} runtime has no "${controls.permission_mode}" approval mode`,
      "unsupported_mode",
    );
  if (controls.mode && !supported?.modes.includes(controls.mode))
    throw badRequest(`the ${row.runtime_provider} runtime has no "${controls.mode}" mode`, "unsupported_mode");
  await repo.setControls(ctx.db, id, controls);
  return get(ctx, auth, id);
}

/**
 * A session the server starts on a member's behalf — a task's lead, or a
 * member working on one of its subtasks. It belongs to that member, runs as
 * the agent given, and uses the agent's channel or, failing that, the member's
 * default one.
 */
export async function createForRun(
  ctx: Ctx,
  tx: typeof ctx.db,
  run: {
    owner: Auth;
    projectId: string;
    deviceId: string;
    agent: {
      id: string;
      runtime: string;
      model: string;
      provider_id: string | null;
      effort: string | null;
      permission_mode: string;
    };
    agentSlug: string;
    cwd: string;
    name: string;
    metadata: Record<string, unknown>;
    origin: "task" | "automation";
  },
): Promise<string> {
  const { agent } = run;
  const chosen = await chooseModel(ctx, run.owner, {
    providerId: agent.provider_id,
    runtime: agent.runtime,
    model: agent.model,
    who: `agent "${run.agentSlug}"`,
  });
  const id = crypto.randomUUID();
  await repo.insert(tx, {
    id,
    org_id: run.owner.orgId,
    owner_id: run.owner.userId,
    project_id: run.projectId,
    device_id: run.deviceId,
    agent_id: agent.id,
    agent_slug: run.agentSlug,
    provider_id: chosen.providerId,
    name: run.name,
    runtime_provider: chosen.runtime,
    model: chosen.model,
    cwd: run.cwd,
    effort: agent.effort,
    permission_mode: agent.permission_mode,
    metadata: run.metadata,
    origin: run.origin,
  });
  return id;
}
