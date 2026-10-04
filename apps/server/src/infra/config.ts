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
  /**
   * 1 = let the server call endpoints on private networks (a model gateway on the same LAN).
   * Off by default: a member-supplied URL must not reach the server's own network.
   */
  ALLOW_PRIVATE_UPSTREAMS: flag.default("0"),
  /**
   * Where uploads wait until they are delivered to a device (nothing lives here for
   * long): `local` (a directory — fine for one server) or `s3` (any S3-compatible
   * store — needed once there is more than one replica).
   */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_DIR: z.string().default("./data/storage"),
  S3_BUCKET: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  /** For S3-compatible stores (MinIO, R2, OSS…). Empty = AWS. */
  S3_ENDPOINT: z.string().default(""),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_FORCE_PATH_STYLE: flag.default("0"),
  /** The largest file a member may upload. Files travel to the device over its link, which carries about this much. */
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),
  /** How long a conversation must be quiet before it is reviewed for what to remember. 0 turns the review off. */
  MEMORY_REVIEW_IDLE_SECONDS: z.coerce.number().int().min(0).default(60),
  /** Override where api/openapi.yaml is read from (the bundled server ships a copy). */
  CONTRACT_FILE: z.string().optional(),
  /** A built web app to serve at `/` (same origin as the API). Empty = look for the workspace's own build. */
  WEB_DIR: z.string().default(""),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration — ${issues}`);
  }
  if (parsed.data.STORAGE_DRIVER === "s3" && !parsed.data.S3_BUCKET)
    throw new Error("invalid configuration — S3_BUCKET: required when STORAGE_DRIVER is s3");
  return parsed.data;
}
