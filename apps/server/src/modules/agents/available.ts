/**
 * What the built-in assistant works with. It names no skills or connectors of
 * its own: each time, it has everything its member can use right now.
 */
import type { Auth, Ctx } from "../../infra/context.ts";
import * as connectors from "../connectors/service.ts";
import * as knowledge from "../knowledge/service.ts";
import * as skills from "../skills/service.ts";

export async function everythingFor(ctx: Ctx, owner: Auth) {
  const [allSkills, allConnectors, bases] = await Promise.all([
    skills.list(ctx, owner),
    connectors.list(ctx, owner),
    knowledge.list(ctx, owner),
  ]);
  return {
    skills: allSkills.filter((skill) => skill.enabled),
    connectors: allConnectors.filter((connector) => connector.enabled),
    knowledgeBases: bases,
  };
}
