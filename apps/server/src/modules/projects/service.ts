/**
 * Projects — a workplace for a team of agents. A project belongs to a member
 * and is shared through the ladder: `use` to work in it, `edit` to change it
 * and its team. Its folder is on a device, never on the server.
 */
import path from "node:path";
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { badRequest, forbidden, notFound } from "../../infra/errors.ts";
import * as audit from "../audit/service.ts";
import * as devices from "../devices/service.ts";
import * as sharing from "../sharing/service.ts";
import * as repo from "./repo.ts";

sharing.registerShareable("project", "projects");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Detail = Schema<"ProjectDetail">;

const present = (row: repo.ProjectRow): Detail => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  root_path: row.root_path,
  icon: row.icon,
  // An agent working in the project starts in its folder.
  cwd: row.root_path,
  device_id: row.device_id,
  permission: row.permission ?? "view",
  owner_id: row.owner_id,
  instructions_md: row.instructions_md,
  default_lead_agent_slug: row.default_lead_agent_slug,
});

/** The project as the caller may see it; 404 when they cannot, 403 when they can but not at this level. */
export async function require(ctx: Ctx, auth: Auth, id: string, needed: sharing.Permission = "view") {
  const row = UUID.test(id) ? await repo.find(ctx.db, auth, id) : undefined;
  if (!row?.permission) throw notFound("project");
  if (!sharing.permissionAtLeast(row.permission, needed))
    throw forbidden(`this needs "${needed}" permission on the project`);
  return row;
}

export const list = async (ctx: Ctx, auth: Auth): Promise<Detail[]> => (await repo.list(ctx.db, auth)).map(present);

export const get = async (ctx: Ctx, auth: Auth, id: string): Promise<Detail> => present(await require(ctx, auth, id));

/** The device a new project's folder is on: the one named, else the caller's own when there is exactly one. */
async function chooseDevice(ctx: Ctx, auth: Auth, wanted: string | undefined): Promise<string | null> {
  if (wanted) return (await devices.get(ctx, auth, wanted, "use")).id;
  const own = (await devices.list(ctx, auth)).filter((device) => device.owner_id === auth.userId);
  return own.length === 1 ? (own[0]?.id ?? null) : null;
}

export async function create(ctx: Ctx, auth: Auth, input: Schema<"ProjectCreateRequest">): Promise<Detail> {
  const name = input.name.trim();
  if (!name) throw badRequest("a project needs a name");
  const rootPath = input.root_path?.trim() || null;
  // Devices may be Windows or POSIX machines; either kind of absolute path is one.
  if (rootPath && !path.posix.isAbsolute(rootPath) && !path.win32.isAbsolute(rootPath))
    throw badRequest("root_path must be an absolute folder on the device");
  const deviceId = await chooseDevice(ctx, auth, input.device_id);
  if (rootPath && !deviceId)
    throw badRequest("a project folder lives on a device: say which with device_id", "device_required");
  const id = crypto.randomUUID();
  await repo.insert(ctx.db, {
    id,
    org_id: auth.orgId,
    owner_id: auth.userId,
    name,
    icon: input.icon ?? null,
    device_id: deviceId,
    root_path: rootPath,
  });
  await audit.record(ctx.db, auth, "project.create", { type: "project", id }, { name });
  return get(ctx, auth, id);
}

export async function rename(ctx: Ctx, auth: Auth, id: string, name: string): Promise<Detail> {
  await require(ctx, auth, id, "edit");
  if (!name.trim()) throw badRequest("a project needs a name");
  await repo.update(ctx.db, id, { name: name.trim() });
  return get(ctx, auth, id);
}

export async function setInstructions(ctx: Ctx, auth: Auth, id: string, instructions: string): Promise<void> {
  await require(ctx, auth, id, "edit");
  await repo.update(ctx.db, id, { instructions_md: instructions });
}

/** The caller has checked that `agentSlug` is a member of the project (or null to clear). */
export async function setDefaultLead(ctx: Ctx, auth: Auth, id: string, agentSlug: string | null): Promise<Detail> {
  await require(ctx, auth, id, "edit");
  await repo.update(ctx.db, id, { default_lead_agent_slug: agentSlug });
  return get(ctx, auth, id);
}

/** What goes with the project. Sessions, knowledge bindings and schedules are not ported yet. */
export async function deletePreview(ctx: Ctx, auth: Auth, id: string): Promise<Schema<"ProjectDeletePreview">> {
  await require(ctx, auth, id);
  return { session_count: 0, doc_binding_count: 0, schedule_count: 0, skill_config_count: 0 };
}

export async function remove(ctx: Ctx, auth: Auth, id: string): Promise<void> {
  await require(ctx, auth, id, "admin");
  await ctx.db.transaction().execute(async (tx) => {
    await sharing.revokeForResource(tx, "project", id);
    await repo.remove(tx, id);
    await audit.record(tx, auth, "project.delete", { type: "project", id });
  });
}
