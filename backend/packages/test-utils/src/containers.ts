/** Real PostgreSQL and Redis for integration tests, started on demand by Testcontainers. */
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { Wait } from "testcontainers";

// The reaper sidecar needs an extra image pull; each helper stops its own
// container instead, so tests also run where that image is unavailable.
process.env["TESTCONTAINERS_RYUK_DISABLED"] ??= "true";

export interface StartedPostgres {
  url: string;
  stop(): Promise<void>;
}
export interface StartedRedis {
  url: string;
  stop(): Promise<void>;
}

export async function startPostgres(
  image = process.env["TEST_POSTGRES_IMAGE"] ?? "postgres:16-alpine",
): Promise<StartedPostgres> {
  // PostgreSQL restarts once during init, so "ready" is the second announcement. Waiting on the
  // log avoids the default in-container port probe, which stalls ~30s on images without `nc`.
  const container = await new PostgreSqlContainer(image)
    // A throwaway database: keep it in memory and skip durability, which is most of its startup time.
    .withTmpFs({ "/var/lib/postgresql/data": "rw" })
    .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"])
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

export async function startRedis(image = process.env["TEST_REDIS_IMAGE"] ?? "redis:7-alpine"): Promise<StartedRedis> {
  const container = await new RedisContainer(image).start();
  return { url: container.getConnectionUrl(), stop: async () => void (await container.stop()) };
}
