import { z } from "zod";

const flag = z.enum(["0", "1", "true", "false"]).transform((v) => v === "1" || v === "true");

const Env = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(8787),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  /** Signs access tokens and encrypts stored credentials. Rotating it invalidates both. */
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
  /** 0 = accounts can only be created through an invite. */
  ALLOW_SIGNUP: flag.default("1"),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_S: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 86_400),
  /** Override where api/openapi.yaml is read from (the bundled server ships a copy). */
  CONTRACT_FILE: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration — ${issues}`);
  }
  return parsed.data;
}
