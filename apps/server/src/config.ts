import path from "node:path";
import { z } from "zod";

const bool = z.enum(["0", "1", "true", "false"]).transform((v) => v === "1" || v === "true");

const Env = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(8787),
  DATABASE_URL: z.string().default("postgres://agentbase:agentbase@127.0.0.1:55432/agentbase"),
  REDIS_URL: z.string().default("redis://127.0.0.1:56379/0"),
  /** Signs tokens and encrypts stored credentials. Rotating it invalidates both. */
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
  /** Externally reachable base URL — used in upload/download links. */
  PUBLIC_URL: z.string().default("http://127.0.0.1:8787"),
  ALLOW_SIGNUP: bool.default("1"),
  CORS_ORIGINS: z.string().default("*"),
  DATA_DIR: z.string().default(path.resolve(".data")),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_S: z.coerce.number().int().default(30 * 86_400),
  LOG_LEVEL: z.string().default("info"),
  /** Built web app to serve at `/`. Empty = look next to the server (monorepo layout). */
  WEB_DIR: z.string().default(""),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration — ${issues}`);
  }
  return parsed.data;
}
