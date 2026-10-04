/** The audit trail: who did what, to what, in which organization. */
import type { Db } from "@agent-base/db";
import * as repo from "./repo.ts";

export interface Actor {
  userId: string | null;
  orgId: string;
}

/**
 * Record an action. Pass the transaction the action ran in, so the entry
 * exists exactly when the change does.
 */
export const record = (
  db: Db,
  actor: Actor,
  action: string,
  resource: { type?: string; id?: string } = {},
  detail: Record<string, unknown> = {},
): Promise<void> =>
  repo.insert(db, {
    org_id: actor.orgId,
    actor_id: actor.userId,
    action,
    resource_type: resource.type ?? null,
    resource_id: resource.id ?? null,
    detail,
  });

export const list = repo.list;
