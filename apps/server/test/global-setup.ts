import { startPostgres, startRedis } from "@agent-base/test-utils";
import type { TestProject } from "vitest/node";

/**
 * One PostgreSQL and one Redis for the whole run. Each test file gets a
 * database and a Redis keyspace of its own inside them (see `harness.ts`),
 * which is as isolated as a container apiece and far gentler on Docker.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  project.provide("pgUrl", pg.url);
  project.provide("redisUrl", redis.url);
  return async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    pgUrl: string;
    redisUrl: string;
  }
}
