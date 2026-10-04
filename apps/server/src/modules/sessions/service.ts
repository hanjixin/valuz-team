/**
 * Sessions — created on the server, run on a device, watched and driven by
 * whoever has access. Who that is flows from three places: the session itself
 * (its owner, and anyone it is shared with), its project (`edit` there means
 * a teammate may drive it, `view`/`use` that they may watch), and its device
 * (`control` there means remote control of everything running on it).
 */
import { managedCwd } from "@agent-base/protocol";
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { badRequest, conflict, forbidden, notFound } from "../../infra/errors.ts";
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
    locked_provider_id: row.provider_id,
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

/** The device a new session runs on: the one named, the project's, else the caller's own that is online. */
export const deviceFor = (ctx: Ctx, auth: Auth, wanted: string | null | undefined, projectDevice: string | null) =>
  chooseDevice(ctx, auth, wanted, projectDevice);

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

export async function create(ctx: Ctx, auth: Auth, input: Schema<"SessionCreateRequest">): Promise<Detail> {
  const quickChat = input.project_id === CHAT_PROJECT;
  const existing = quickChat ? null : await projects.require(ctx, auth, input.project_id, "use");
  const deviceId = await chooseDevice(ctx, auth, input.device_id, existing?.device_id ?? null);
  if (existing?.root_path && existing.device_id !== deviceId)
    throw badRequest("this project's folder is on another device; its sessions run there", "wrong_device");

  const agent = input.agent_slug
    ? await members.resolveForSession(ctx, auth, existing?.id ?? null, input.agent_slug)
    : null;
  const defaults = await providers.getDefaults(ctx, auth);
  const runtime = input.runtime_id ?? agent?.runtime ?? defaults.default_runtime;
  const providerId = input.provider_id ?? agent?.provider_id ?? defaults.default_provider_id;
  // A channel is optional for the runtimes that can sign in on the device itself.
  const channel = providerId ? await providers.describe(ctx, auth, providerId) : null;
  if (channel && !protocolFor(runtime, channel.protocols as ApiProtocol[]))
    throw badRequest(`this model channel cannot drive the ${runtime} runtime`, "protocol_mismatch");
  if (!channel && runtime === "deepagents")
    throw badRequest("this runtime needs a model channel: add one in Settings → Models", "provider_required");

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
    provider_id: providerId,
    name: input.title?.trim() || null,
    runtime_provider: runtime,
    model: input.model_id || agent?.model || channel?.default_model || defaults.default_model || "",
    // A project without a folder of its own works in one the device manages; so does every quick chat.
    cwd: project.root_path ?? managedCwd(quickChat ? `chat-${id}` : `project-${project.id}`),
    effort: input.effort ?? agent?.effort ?? null,
    permission_mode: input.permission_mode ?? agent?.permission_mode ?? "full_access",
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
  },
): Promise<string> {
  const { agent } = run;
  const defaults = await providers.getDefaults(ctx, run.owner);
  const providerId = agent.provider_id ?? defaults.default_provider_id;
  const channel = providerId ? await providers.describe(ctx, run.owner, providerId) : null;
  if (channel && !protocolFor(agent.runtime, channel.protocols as ApiProtocol[]))
    throw badRequest(
      `agent "${run.agentSlug}" runs on ${agent.runtime}, which its model channel cannot drive`,
      "protocol_mismatch",
    );
  if (!channel && agent.runtime === "deepagents")
    throw badRequest(`agent "${run.agentSlug}" needs a model channel`, "provider_required");
  const id = crypto.randomUUID();
  await repo.insert(tx, {
    id,
    org_id: run.owner.orgId,
    owner_id: run.owner.userId,
    project_id: run.projectId,
    device_id: run.deviceId,
    agent_id: agent.id,
    agent_slug: run.agentSlug,
    provider_id: providerId,
    name: run.name,
    runtime_provider: agent.runtime,
    model: agent.model || channel?.default_model || defaults.default_model || "",
    cwd: run.cwd,
    effort: agent.effort,
    permission_mode: agent.permission_mode,
    metadata: run.metadata,
  });
  return id;
}
