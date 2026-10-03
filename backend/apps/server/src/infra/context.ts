import type { Db } from "@agent-base/db";
import type { Redis } from "ioredis";
import type { Config } from "./config.ts";

/** What every module is handed: configuration and the shared infrastructure clients. */
export interface Ctx {
  config: Config;
  db: Db;
  redis: Redis;
}
