import type { Schema } from "@agent-base/contract";
import { requireAuth, requireOrgAdmin } from "../../infra/auth.ts";
import type { Handler } from "../../infra/context.ts";
import * as audit from "../audit/service.ts";
import * as service from "./service.ts";

const teamId = (req: Parameters<Handler>[0]): string => (req.params as { team_id: string }).team_id;

/** Everyone in the organization can see its teams; changing them takes an owner or admin. */
const asAdmin = async (req: Parameters<Handler>[0]) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  requireOrgAdmin(auth);
  return { ctx, auth };
};

export const listTeams: Handler = async (req) => {
  const ctx = req.server.ctx;
  const auth = await requireAuth(ctx, req);
  return { teams: await service.list(ctx.db, auth.orgId) };
};

export const createTeam: Handler = async (req, reply) => {
  const { ctx, auth } = await asAdmin(req);
  const team = await service.create(ctx.db, auth, (req.body as Schema<"TeamNameRequest">).name);
  await audit.record(ctx.db, auth, "team.create", { type: "team", id: team.id }, { name: team.name });
  return reply.code(201).send(team);
};

export const updateTeam: Handler = async (req) => {
  const { ctx, auth } = await asAdmin(req);
  return service.rename(ctx.db, auth, teamId(req), (req.body as Schema<"TeamNameRequest">).name);
};

export const setTeamMembers: Handler = async (req) => {
  const { ctx, auth } = await asAdmin(req);
  const team = await service.setMembers(ctx.db, auth, teamId(req), (req.body as Schema<"TeamMembersRequest">).user_ids);
  await audit.record(ctx.db, auth, "team.set_members", { type: "team", id: team.id }, { user_ids: team.member_ids });
  return team;
};

export const deleteTeam: Handler = async (req, reply) => {
  const { ctx, auth } = await asAdmin(req);
  await service.remove(ctx.db, auth, teamId(req));
  await audit.record(ctx.db, auth, "team.delete", { type: "team", id: teamId(req) });
  return reply.code(204).send();
};
