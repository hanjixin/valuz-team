/**
 * The agent library. An agent is a digital worker: an identity, a working
 * method (instructions), a brain (runtime + model channel + model + effort) and
 * equipment (skills, connectors, knowledge). It belongs to the member who made
 * it and is shared through the ladder — `use` lets someone work with it, `edit`
 * lets them change it.
 */
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { badRequest, conflict, forbidden, notFound } from "../../infra/errors.ts";
import * as audit from "../audit/service.ts";
import * as providers from "../providers/service.ts";
import * as sharing from "../sharing/service.ts";
import * as repo from "./repo.ts";
import { MAX_SLUG_LENGTH, deriveSlug, ensureUniqueSlug, isValidSlug } from "./slug.ts";

sharing.registerShareable("agent", "agents");

type Agent = Schema<"Agent">;

function present(row: repo.AgentRow): Agent {
  const permission = row.permission ?? "view";
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    runtime: row.runtime,
    model: row.model,
    // With no channel of its own, a Claude or Codex agent runs on the device's login: the subscription channel.
    provider_id: row.provider_id ?? providers.subscriptionFor(row.runtime)?.id ?? null,
    effort: row.effort as Agent["effort"],
    skills: row.skills,
    connector_types: row.connector_types,
    knowledge_scope: row.knowledge_scope,
    kind: "standard",
    resource_policy: "explicit",
    inherit_global_instructions: row.inherit_global_instructions,
    permission_mode: row.permission_mode,
    source: "custom",
    readonly: !sharing.permissionAtLeast(permission, "edit"),
    deletable: permission === "admin",
    avatar: row.avatar,
    permission,
    owner_id: row.owner_id,
    owner_name: row.owner_name,
  };
}

/** The agent as the caller may see it; 404 when they cannot, 403 when they can but not at this level. */
export async function require(ctx: Ctx, auth: Auth, slug: string, needed: sharing.Permission = "view") {
  const row = await repo.findBySlug(ctx.db, auth, slug);
  if (!row?.permission) throw notFound("agent");
  if (!sharing.permissionAtLeast(row.permission, needed))
    throw forbidden(`this needs "${needed}" permission on the agent`);
  return row;
}

export const list = async (ctx: Ctx, auth: Auth): Promise<Agent[]> => (await repo.list(ctx.db, auth)).map(present);

export const get = async (ctx: Ctx, auth: Auth, slug: string): Promise<Agent> =>
  present(await require(ctx, auth, slug));

/** A slug the caller asked for must be free; one derived from the name is made unique. */
async function chooseSlug(ctx: Ctx, auth: Auth, wanted: string | null | undefined, name: string): Promise<string> {
  const taken = await repo.slugsInOrg(ctx.db, auth.orgId);
  const slug = wanted?.trim();
  if (!slug) return ensureUniqueSlug(deriveSlug(name), taken);
  if (!isValidSlug(slug))
    throw badRequest(
      `a slug is ASCII letters and digits separated by single dashes, at most ${MAX_SLUG_LENGTH} characters`,
      "invalid_slug",
    );
  if (taken.has(slug)) throw conflict(`agent '${slug}' already exists`, "slug_taken");
  return slug;
}

/** Whether a slug is already an agent's in this organization — the caller's or anyone else's. */
export const slugTaken = async (ctx: Ctx, auth: Auth, slug: string): Promise<boolean> =>
  (await repo.slugsInOrg(ctx.db, auth.orgId)).has(slug);

/**
 * The channel an agent is given, as it is stored. It must be one its author can
 * run models through. A subscription channel is not stored at all: it means
 * "this runtime, on the device's own login", so the agent keeps the runtime and
 * no channel.
 */
export async function storedChannel<T extends { provider_id?: string | null; runtime?: string | null }>(
  ctx: Ctx,
  auth: Auth,
  input: T,
): Promise<T> {
  const subscription = providers.subscriptionOf(input.provider_id);
  if (subscription) return { ...input, provider_id: null, runtime: subscription.runtime };
  if (input.provider_id) await providers.assertUsable(ctx, auth, input.provider_id);
  return input;
}

export async function create(ctx: Ctx, auth: Auth, given: Schema<"CreateAgentRequest">): Promise<Agent> {
  const name = given.name.trim();
  if (!name) throw badRequest("an agent needs a name");
  const input = await storedChannel(ctx, auth, given);
  const defaults = await providers.getDefaults(ctx, auth);
  const id = crypto.randomUUID();
  const slug = await chooseSlug(ctx, auth, input.slug, name);
  await repo.insert(ctx.db, {
    id,
    org_id: auth.orgId,
    owner_id: auth.userId,
    slug,
    name,
    description: input.description ?? "",
    instructions: input.instructions ?? "",
    // The contract's own defaults are applied by validation; these cover a caller that sent nulls.
    runtime: input.runtime ?? defaults.default_runtime,
    model: input.model ?? defaults.default_model ?? "",
    provider_id: input.provider_id ?? null,
    effort: input.effort ?? null,
    skills: input.skills ?? [],
    connector_types: input.connector_types ?? [],
    knowledge_scope: input.knowledge_scope ?? [],
    inherit_global_instructions: input.inherit_global_instructions ?? true,
    permission_mode: input.permission_mode ?? "full_access",
    avatar: input.avatar ?? null,
  });
  await audit.record(ctx.db, auth, "agent.create", { type: "agent", id }, { slug });
  return get(ctx, auth, slug);
}

export async function update(ctx: Ctx, auth: Auth, slug: string, given: Schema<"UpdateAgentRequest">): Promise<Agent> {
  const existing = await require(ctx, auth, slug, "edit");
  const toSubscription = providers.subscriptionOf(given.provider_id) !== null;
  const input = await storedChannel(ctx, auth, given);
  // In this request null means "leave it"; only what was actually sent changes.
  const changes = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<repo.AgentValues>;
  // Moving to a subscription is the one change that sets the channel to nothing.
  if (toSubscription) changes.provider_id = null;
  if (typeof changes.name === "string" && !changes.name.trim()) throw badRequest("an agent needs a name");
  if (Object.keys(changes).length > 0) {
    await repo.update(ctx.db, existing.id, changes);
    await audit.record(
      ctx.db,
      auth,
      "agent.update",
      { type: "agent", id: existing.id },
      { fields: Object.keys(changes) },
    );
  }
  return get(ctx, auth, slug);
}

export async function remove(ctx: Ctx, auth: Auth, slug: string): Promise<void> {
  const existing = await require(ctx, auth, slug, "admin");
  await ctx.db.transaction().execute(async (tx) => {
    await sharing.revokeForResource(tx, "agent", existing.id);
    await repo.remove(tx, existing.id);
    await audit.record(tx, auth, "agent.delete", { type: "agent", id: existing.id }, { slug });
  });
}

/** Anyone who can see an agent can take a copy; the copy is theirs, private, with no shares. */
export async function copy(ctx: Ctx, auth: Auth, slug: string, input: Schema<"CopyAgentRequest">): Promise<Agent> {
  const source = await require(ctx, auth, slug);
  const name = input.name?.trim() || `${source.name} (copy)`;
  // The source's channel comes along only if the copier may use it too.
  const channel = source.provider_id
    ? await providers.assertUsable(ctx, auth, source.provider_id).then(
        () => source.provider_id,
        () => null,
      )
    : null;
  return create(ctx, auth, {
    name,
    slug: input.slug ?? null,
    description: source.description,
    instructions: source.instructions,
    runtime: source.runtime as Schema<"CreateAgentRequest">["runtime"],
    model: source.model,
    provider_id: channel,
    effort: source.effort as Agent["effort"],
    skills: source.skills,
    connector_types: source.connector_types,
    knowledge_scope: source.knowledge_scope,
    inherit_global_instructions: source.inherit_global_instructions,
    permission_mode: source.permission_mode,
    avatar: source.avatar,
  });
}

/** The agent a session is bound to, as it is now. No permission check: the session is the authorization. */
export const forSession = (ctx: Ctx, id: string) => repo.findById(ctx.db, id);
