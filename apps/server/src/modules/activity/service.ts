/**
 * One feed of what the caller's agents have been doing: their conversations
 * and their projects' tasks, newest first. Each kind is paged by its own module
 * in the same order; this interleaves the two pages and cuts one.
 */
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { badRequest } from "../../infra/errors.ts";
import * as projects from "../projects/service.ts";
import * as sessions from "../sessions/service.ts";
import * as tasks from "../tasks/service.ts";

type Item = Schema<"ActivityItem">;
type Tab = "all" | "chat" | "task" | "automation";

interface Position {
  sortAt: number;
  id: string;
}

const encode = (at: Position): string => Buffer.from(`${at.sortAt}:${at.id}`).toString("base64url");

function decode(cursor: string): Position {
  const [sortAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
  if (!sortAt || !id || !/^\d+$/.test(sortAt) || !/^[0-9a-f-]{36}$/i.test(id)) throw badRequest("malformed cursor");
  return { sortAt: Number(sortAt), id };
}

export async function page(
  ctx: Ctx,
  auth: Auth,
  query: { projectId?: string; tab: Tab; limit: number; cursor?: string },
): Promise<Schema<"ActivityPage">> {
  // Nothing is run by an automation yet, so that tab is empty.
  if (query.tab === "automation") return { items: [], next_cursor: null };
  const visible = await projects.list(ctx, auth);
  const names = new Map(visible.map((project) => [project.id, project.kind === "chat" ? null : project.name]));
  const projectIds = visible.map((project) => project.id);
  if (query.projectId && !projectIds.includes(query.projectId)) return { items: [], next_cursor: null };
  const page = {
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.cursor ? { before: decode(query.cursor) } : {}),
    // One more than asked for, to know whether anything is left.
    limit: query.limit + 1,
  };
  const [chats, work] = await Promise.all([
    query.tab === "task" ? [] : sessions.recent(ctx, auth, projectIds, page),
    query.tab === "chat" ? [] : tasks.recent(ctx, projectIds, page),
  ]);
  const items: Item[] = [
    ...chats.map((row): Item => ({
      kind: "chat",
      id: row.id,
      title: row.name ?? "",
      status: row.status,
      is_automation: false,
      project_id: row.project_id,
      project_name: names.get(row.project_id) ?? null,
      sort_at: Number(row.sort_at),
    })),
    ...work.map((row): Item => ({
      kind: "task",
      id: row.id,
      title: row.title,
      status: row.status,
      is_automation: false,
      project_id: row.project_id,
      project_name: names.get(row.project_id) ?? null,
      sort_at: Number(row.sort_at),
    })),
  ].sort((a, b) => b.sort_at - a.sort_at || (a.id < b.id ? 1 : -1));
  const shown = items.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: shown,
    next_cursor: items.length > query.limit && last ? encode({ sortAt: last.sort_at, id: last.id }) : null,
  };
}
