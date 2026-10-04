import type { Db, OrgRole } from "@agent-base/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Config } from "./config.ts";

/** What every module is handed: configuration and the shared infrastructure clients. */
export interface Ctx {
  config: Config;
  db: Db;
  redis: Redis;
  startedAt: number;
}

/** The signed-in caller, in the organization this request acts in. */
export interface Auth {
  userId: string;
  name: string;
  orgId: string;
  role: OrgRole;
}

/** A contract operation. Exported from a module's `handlers.ts` under its operationId. */
export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

declare module "fastify" {
  interface FastifyInstance {
    ctx: Ctx;
  }
  interface FastifyRequest {
    /** Set by the bearer security handler: the verified user id of this request. */
    userId?: string;
  }
}
