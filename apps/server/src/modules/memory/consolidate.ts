/**
 * Tidying a memory scope: entries only ever pile up, so now and then a scope is
 * rewritten as a shorter list that says the same — overlapping entries merged,
 * a contradiction settled for the newer, what is stale dropped. A model does
 * the rewriting (on a device, like everything a model does here); the store
 * decides whether to take the result, and keeps what was there as a snapshot.
 */
import type { Schema } from "@agent-base/contract";
import type { Auth, Ctx } from "../../infra/context.ts";
import { badRequest, conflict, notFound } from "../../infra/errors.ts";
import { askMember } from "../sessions/dispatch.ts";
import { consolidatePrompt } from "./prompts.ts";
import * as memory from "./service.ts";

/** A scope this full is tidied without being asked. */
export const TIDY_AT = 0.8;

export interface Outcome {
  changed: boolean;
  before: number;
  after: number;
}

/** The entries in a model's reply, whatever it wrapped the JSON in. Null when there is no such list. */
function entriesIn(raw: string): string[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const entries = (JSON.parse(raw.slice(start, end + 1)) as { entries?: unknown }).entries;
    return Array.isArray(entries) && entries.every((entry) => typeof entry === "string") ? entries : null;
  } catch {
    return null;
  }
}

/**
 * Tidy one scope with `ask` (a model, somewhere it may be asked). Nothing is
 * written unless the whole result is acceptable; `MemoryError` says why not.
 */
export async function consolidate(
  ctx: Ctx,
  owner: memory.Owner,
  target: memory.Target,
  ask: (prompt: string) => Promise<string | null>,
): Promise<Outcome> {
  const current = await memory.detailed(ctx, owner, target);
  const unchanged = { changed: false, before: current.length, after: current.length };
  if (current.length < 2) return unchanged;
  const contents = current.map((entry) => entry.content);
  const reply = await ask(
    consolidatePrompt({
      target,
      entries: current,
      usage: memory.usage(contents, target),
      customInstructions: (await memory.getSettings(ctx, owner)).custom_instructions,
    }),
  );
  const entries = reply === null ? null : entriesIn(reply);
  if (!entries) throw new memory.MemoryError("the model gave no usable list");
  const tidy = entries.map((entry) => entry.trim()).filter(Boolean);
  if (tidy.join("\n") === contents.join("\n")) return unchanged;
  if (!(await memory.rewrite(ctx, owner, target, current, tidy)))
    throw new memory.MemoryError("the scope changed while it was being tidied");
  return { changed: true, before: current.length, after: (await memory.read(ctx, owner, target)).length };
}

// ------------------------------------------------------------------ for the app

const scoped = async (ctx: Ctx, auth: Auth, input: Schema<"MemoryClear">): Promise<memory.Owner> => {
  if (input.target === "project" && !input.project_id) throw badRequest("a project's memory needs `project_id`");
  return memory.ownerFor(ctx, auth, input.target === "project" ? input.project_id : undefined, true);
};

/** A member asks for a scope to be tidied now: their own model, on a device of theirs that is online. */
export async function consolidateScope(
  ctx: Ctx,
  auth: Auth,
  input: Schema<"MemoryClear">,
): Promise<Schema<"MemoryConsolidation">> {
  const owner = await scoped(ctx, auth, input);
  try {
    const outcome = await consolidate(ctx, owner, input.target, (prompt) => askMember(ctx, auth, prompt));
    return { ...outcome, memory: await memory.view(ctx, auth, input.project_id) };
  } catch (err) {
    if (err instanceof memory.MemoryError)
      throw conflict(`memory was left as it was: ${err.message}`, "not_consolidated");
    throw err;
  }
}

export async function restoreScope(ctx: Ctx, auth: Auth, input: Schema<"MemoryClear">): Promise<Schema<"MemoryView">> {
  const owner = await scoped(ctx, auth, input);
  if (!(await memory.restore(ctx, owner, input.target))) throw notFound("memory snapshot");
  return memory.view(ctx, auth, input.project_id);
}
