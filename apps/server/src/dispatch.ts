/**
 * Session creation and turn dispatch — shared by the HTTP routes and the task
 * orchestrator. The server keeps no secrets in a session row: the model
 * credential, connector credentials, and skill bundles are resolved from the
 * shared library every time a turn is dispatched.
 */
import {
  type Actor,
  AgentConfig,
  type McpServerConfig,
  McpServerConfig as McpServerConfigSchema,
  type ModelProvider,
  ModelSettings,
  Session,
  type SkillBundle,
  type UserMessage,
} from "@agent-base/protocol";
import type { Ctx } from "./context.ts";
import { type Queryable, type Row, json } from "./db.ts";
import { orgChannel } from "./device-hub.ts";
import { DOCS_MCP_PATH } from "./documents.ts";
import { badRequest, conflict } from "./http.ts";
import { toolkitServer } from "./mcp.ts";
import { PROJECT_MCP_PATH, PROJECT_MEMORY_NOTE, PROJECT_TOOLS_NOTE, memoryPrompt } from "./project-tools.ts";
import { taskDispatchExtras } from "./tasks/prompts.ts";

export const ALLOWED_PROTOCOLS: Record<string, readonly string[]> = {
  claude_agent: ["anthropic"],
  codex: ["openai_response"],
  valuz_agent: ["openai_completion"],
  deepagents: ["openai_completion"],
};

export interface NewSession {
  orgId: string;
  ownerId: string;
  /** The library agent row (caller has already checked it may be used). */
  agent: Row;
  deviceId: string;
  projectId: string | null;
  /** Defaults to the agent's own model channel when undefined. */
  providerId?: string | null;
  cwd: string;
  title?: string;
  model?: string;
  modelSettings?: ModelSettings | null;
  permissionMode?: string;
  mode?: string;
  metadata?: Record<string, unknown>;
}

/** Insert a session row snapshotting the agent. Permission checks are the caller's. */
export async function createSession(ctx: Ctx, input: NewSession, db: Queryable = ctx.db): Promise<Row> {
  const agent = input.agent;
  const runtime = agent["runtime"] as string;
  const providerId = input.providerId === undefined ? (agent["provider_id"] as string | null) : input.providerId;
  let model = input.model ?? (agent["model"] as string);
  if (providerId) {
    const provider = await db.one<{ protocol: string; default_model: string | null }>(
      "SELECT protocol, default_model FROM providers WHERE id = $1 AND org_id = $2",
      [providerId, input.orgId],
    );
    if (!ALLOWED_PROTOCOLS[runtime]?.includes(provider?.protocol ?? "")) {
      throw badRequest(`a ${provider?.protocol} model channel cannot drive the ${runtime} runtime`, "protocol_mismatch");
    }
    model ||= provider?.default_model ?? "";
  } else if (runtime === "valuz_agent" || runtime === "deepagents") {
    throw badRequest(`agent "${String(agent["slug"])}" runs on valuz_agent and needs a model channel (provider_id)`, "provider_required");
  }
  const settings = input.modelSettings ?? (agent["effort"] ? ModelSettings.parse({ effort: agent["effort"] }) : null);
  const config = AgentConfig.parse({
    id: agent["id"],
    name: agent["name"],
    model,
    runtime_provider: runtime,
    instructions: agent["instructions"],
    skills: agent["skills"],
    permission_mode: agent["permission_mode"],
    effort: agent["effort"],
    metadata: { slug: agent["slug"], connectors: agent["connectors"] },
  });
  const row = await db.one(
    `INSERT INTO sessions (id, org_id, owner_id, device_id, project_id, agent_id, provider_id, title, runtime_provider, model, cwd,
                           agent_config, model_settings, instructions, permission_mode, mode, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [
      crypto.randomUUID(), input.orgId, input.ownerId, input.deviceId, input.projectId, agent["id"], providerId, input.title ?? "", runtime, model, input.cwd,
      json(config), json(settings), agent["instructions"], input.permissionMode ?? agent["permission_mode"], input.mode ?? "default", json(input.metadata ?? {}),
    ],
  );
  return row as Row;
}

/** Resolve everything a device needs to run a turn, from the live library. */
export async function resolveDispatch(ctx: Ctx, row: Row): Promise<{ session: Session; skillBundles: SkillBundle[] }> {
  const orgId = row["org_id"] as string;
  let modelProvider: ModelProvider | null = null;
  if (row["provider_id"]) {
    const p = await ctx.db.one<{ protocol: string; base_url: string | null; secret_enc: string | null; enabled: boolean }>(
      "SELECT protocol, base_url, secret_enc, enabled FROM providers WHERE id = $1 AND org_id = $2",
      [row["provider_id"], orgId],
    );
    if (!p || !p.enabled) throw conflict("this session's model channel was removed or disabled", "provider_unavailable");
    if (!p.secret_enc) throw conflict("this session's model channel has no API key configured", "provider_unavailable");
    modelProvider = { api_key: ctx.box.open("provider", p.secret_enc), base_url: p.base_url, api_protocol: p.protocol as ModelProvider["api_protocol"] };
  }

  // Deployment is a live reference: equipment and instructions follow the agent as it is now.
  const snapshot = AgentConfig.parse(row["agent_config"]);
  const agent = row["agent_id"]
    ? await ctx.db.one<{ instructions: string; skills: string[]; connectors: string[] }>(
        "SELECT instructions, skills, connectors FROM agents WHERE id = $1",
        [row["agent_id"]],
      )
    : null;
  const skillSlugs = agent?.skills ?? snapshot.skills;
  const connectorSlugs = agent?.connectors ?? ((snapshot.metadata["connectors"] as string[] | undefined) ?? []);

  const skills = await ctx.db.query<{ slug: string; version: number; files: SkillBundle["files"] }>(
    "SELECT slug, version, files FROM skills WHERE org_id = $1 AND slug = ANY($2::text[])",
    [orgId, skillSlugs],
  );
  const connectors = await ctx.db.query<{ slug: string; config: Row; secret_enc: string | null }>(
    "SELECT slug, config, secret_enc FROM connectors WHERE org_id = $1 AND slug = ANY($2::text[]) AND enabled",
    [orgId, connectorSlugs],
  );
  const mcpServers: McpServerConfig[] = connectors.map((c) => {
    const secrets = c.secret_enc ? (JSON.parse(ctx.box.open("connector", c.secret_enc)) as Record<string, string>) : {};
    const config = McpServerConfigSchema.parse({ ...c.config, name: c.slug });
    return config.transport === "stdio"
      ? { ...config, env: { ...config.env, ...secrets } }
      : { ...config, headers: { ...config.headers, ...secrets } };
  });

  const project = row["project_id"]
    ? await ctx.db.one<{ name: string; instructions_md: string; memory_summary: string | null }>(
        "SELECT name, instructions_md, memory_summary FROM projects WHERE id = $1",
        [row["project_id"]],
      )
    : null;
  // Sessions with a knowledge base in scope get the docs toolkit.
  const docs = await ctx.db.one<{ n: number }>(
    "SELECT count(*)::int AS n FROM documents WHERE org_id = $1 AND status = 'ready' AND (project_id IS NULL OR project_id = $2::uuid)",
    [orgId, row["project_id"] ?? null],
  );
  if (docs && docs.n > 0) mcpServers.push(await toolkitServer(ctx, row["id"] as string, "docs", DOCS_MCP_PATH));
  const docsNote = docs && docs.n > 0
    ? `## Knowledge base\n${docs.n} document(s) are available through the docs tools (doc_search, doc_read, list_doc_scope). Search them before answering anything they may cover, and name the document you relied on.`
    : "";

  // Project sessions keep the project's memory and can hand work to the team.
  const projectMemory = row["project_id"] ? await memoryPrompt(ctx, row["project_id"] as string) : "";
  if (row["project_id"]) mcpServers.push(await toolkitServer(ctx, row["id"] as string, "project", PROJECT_MCP_PATH));

  // A session working for a task gets its role protocol and the task toolkit.
  const task = await taskDispatchExtras(ctx, row);
  if (task?.mcpServer) mcpServers.push(task.mcpServer);
  const instructions = [
    agent?.instructions ?? (row["instructions"] as string),
    project?.instructions_md ? `## Project: ${project.name}\n${project.instructions_md}` : "",
    projectMemory,
    row["project_id"] ? (task ? PROJECT_MEMORY_NOTE : PROJECT_TOOLS_NOTE) : "",
    docsNote,
    task?.instructions ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const session = Session.parse({
    id: row["id"],
    agent_config: { ...snapshot, instructions, skills: skillSlugs, mcp_servers: [] },
    cwd: row["cwd"],
    runtime_provider: row["runtime_provider"],
    user_id: row["owner_id"],
    model: row["model"],
    model_provider: modelProvider,
    model_settings: row["model_settings"],
    instructions,
    skills: skillSlugs,
    mcp_servers: mcpServers,
    permission_mode: row["permission_mode"],
    mode: row["mode"],
    status: "running",
    metadata: row["metadata"],
    runtime_session_id: row["runtime_session_id"],
    todos: row["todos"],
    created_at: new Date(row["created_at"] as string).getTime(),
  });
  return { session, skillBundles: skills.map((s) => ({ slug: s.slug, version: s.version, files: s.files })) };
}

/**
 * Start a turn on the session's device. Returns the new message id.
 * Throws 409 `session_busy` when a turn is already running, 503 when the
 * device is offline; a failed dispatch leaves no trace behind.
 */
export async function dispatchTurn(ctx: Ctx, row: Row, userMessage: UserMessage, actor: Actor): Promise<string> {
  const deviceId = row["device_id"] as string | null;
  if (!deviceId) throw conflict("this session's device was removed", "device_removed");
  const dispatch = await resolveDispatch(ctx, row);

  // The status flip is the lock: only one sender can move it to `running`.
  const claimed = await ctx.db.one(
    "UPDATE sessions SET status = 'running', stop_reason = NULL, updated_at = now() WHERE id = $1 AND status <> 'running' RETURNING id",
    [row["id"]],
  );
  if (!claimed) throw conflict("this session is already running a turn", "session_busy");
  const messageId = crypto.randomUUID();
  try {
    await ctx.db.query("INSERT INTO messages (id, session_id, actor_id, user_message, status, started_at) VALUES ($1, $2, $3, $4, 'running', $5)", [
      messageId, row["id"], actor.user_id, json(userMessage), Date.now(),
    ]);
    await ctx.hub.call(
      deviceId,
      "session.run",
      { session: dispatch.session, message_id: messageId, user_message: userMessage, skill_bundles: dispatch.skillBundles },
      actor,
    );
  } catch (err) {
    await ctx.db.query("DELETE FROM messages WHERE id = $1", [messageId]);
    await ctx.db.query("UPDATE sessions SET status = 'idle' WHERE id = $1", [row["id"]]);
    throw err;
  }
  await ctx.pubsub.publish(orgChannel(row["org_id"] as string), { type: "session.updated", session_id: row["id"], status: "running", actor_id: actor.user_id });
  return messageId;
}

/**
 * Send the next queued message of an idle session, as the person who queued
 * it. Returns false when there was nothing to send or the session is busy.
 */
export async function drainQueue(ctx: Ctx, sessionId: string): Promise<boolean> {
  const next = await ctx.db.one<{ id: string; text: string; actor_id: string; name: string }>(
    `DELETE FROM queued_inputs WHERE id = (SELECT id FROM queued_inputs WHERE session_id = $1 ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, text, actor_id, (SELECT name FROM users WHERE id = actor_id) AS name`,
    [sessionId],
  );
  if (!next) return false;
  const session = await ctx.db.one("SELECT * FROM sessions WHERE id = $1", [sessionId]);
  try {
    if (!session) return false;
    await dispatchTurn(ctx, session, { text: next.text, attachments: [], additional_context: "" }, { user_id: next.actor_id, name: next.name });
    return true;
  } catch {
    // Not sent (busy, or the device is offline): it goes back to the front of the queue.
    await ctx.db.query(
      "INSERT INTO queued_inputs (id, session_id, actor_id, text, created_at) VALUES ($1, $2, $3, $4, (SELECT COALESCE(min(created_at), now()) - interval '1 millisecond' FROM queued_inputs WHERE session_id = $2))",
      [next.id, sessionId, next.actor_id, next.text],
    );
    return false;
  }
}
