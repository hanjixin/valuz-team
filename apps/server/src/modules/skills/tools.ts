/** The `skill_manage` tool: an agent keeps a procedure it worked out, or corrects a skill it found wrong. */
import { authFor } from "../../infra/auth.ts";
import type { Auth, Ctx } from "../../infra/context.ts";
import { HttpError } from "../../infra/errors.ts";
import { ToolError } from "../../infra/toolkit.ts";
import * as sessions from "../sessions/service.ts";
import { announce } from "./learn.ts";
import { TOOL_DESCRIPTION } from "./prompts.ts";
import * as skills from "./service.ts";

export const SKILLS_TOOLKIT = { name: "skills", path: "/v1/mcp/skills" };
const ACTIONS = ["list", "view", "create", "patch", "write_file"] as const;

export const SKILLS_TOOLS = [
  {
    name: "skill_manage",
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        skill: { type: "string", description: "The skill's slug, for view/patch/write_file." },
        name: { type: "string", description: "create: a short name." },
        description: { type: "string", description: "create: when to use the skill." },
        instructions: { type: "string", description: "create: the procedure, in Markdown." },
        old_text: { type: "string", description: "patch: the exact text to replace; must match once." },
        new_text: { type: "string", description: "patch: what replaces it." },
        path: { type: "string", description: "write_file: a path inside the skill, e.g. scripts/check.sh." },
        content: { type: "string", description: "write_file: the file's text." },
      },
      required: ["action"],
    },
  },
];

/** Who is calling: the member the session works for, and the session itself. */
export interface Caller {
  auth: Auth;
  sessionId: string;
  agentId: string | null;
}

/** A session may write skills when its owner lets their agents do so. */
export async function authorize(ctx: Ctx, sessionId: string): Promise<Caller | null> {
  const session = await sessions.byId(ctx, sessionId);
  const auth = session ? await authFor(ctx, session.org_id, session.owner_id) : null;
  if (!session || !auth || !(await skills.learningSettings(ctx, auth)).auto_learn) return null;
  return { auth, sessionId: session.id, agentId: session.agent_id };
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export async function callTool(ctx: Ctx, caller: Caller, tool: string, args: Record<string, unknown>) {
  if (tool !== "skill_manage") throw new ToolError(`unknown tool "${tool}"`);
  const action = args["action"] as (typeof ACTIONS)[number];
  if (!ACTIONS.includes(action)) throw new ToolError(`skill_manage: 'action' must be ${ACTIONS.join("|")}`);
  const { auth } = caller;
  const skill = text(args["skill"]);
  if (action !== "list" && action !== "create" && !skill) throw new ToolError("skill_manage: 'skill' is required");
  try {
    if (action === "list")
      return {
        skills: (await skills.list(ctx, auth)).map((item) => ({
          slug: item.slug,
          name: item.name,
          description: item.description,
          editable: !item.readonly,
        })),
      };
    if (action === "view") return await skills.instructionsFor(ctx, auth, skill);
    if (action === "create") {
      const created = await skills.learn(ctx, auth, {
        name: text(args["name"]),
        description: text(args["description"]),
        instructions: text(args["instructions"]),
      });
      await announce(ctx, caller, { kind: "created", slug: created.slug, name: created.name });
      return { created: created.slug, message: "saved to the skill library; future sessions can use it" };
    }
    if (action === "patch") {
      const amended = await skills.amend(ctx, auth, skill, text(args["old_text"]), text(args["new_text"]));
      await announce(ctx, caller, { kind: "amended", slug: amended.slug, name: amended.name });
      return { patched: amended.slug, version: amended.version };
    }
    const written = await skills.attachFile(ctx, auth, skill, text(args["path"]), text(args["content"]));
    return { written: text(args["path"]), skill: written.slug, version: written.version };
  } catch (err) {
    // What the library refuses is said to the agent in words it can act on.
    if (err instanceof HttpError) throw new ToolError(`skill_manage: ${err.message}`);
    throw err;
  }
}
