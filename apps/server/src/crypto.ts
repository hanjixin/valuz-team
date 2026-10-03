/** Password hashing, token hashing, and the secret box for stored credentials. */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Opaque bearer tokens (refresh, device, invite) are stored only as a hash. */
export const newToken = (prefix: string): string => `${prefix}_${randomBytes(32).toString("base64url")}`;
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * AES-256-GCM box for provider keys, connector credentials, and storage
 * secrets. Keys are derived per purpose from APP_SECRET, so a ciphertext
 * copied between columns never decrypts.
 */
export class SecretBox {
  constructor(private readonly appSecret: string) {}

  private key(purpose: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.appSecret, "agent-base", purpose, 32));
  }

  seal(purpose: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(purpose), iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  open(purpose: string, sealed: string): string {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("malformed secret");
    const decipher = createDecipheriv("aes-256-gcm", this.key(purpose), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }

  /** Short-lived signed grant (local-storage upload/download links). */
  sign(purpose: string, payload: string): string {
    return createHmac("sha256", this.key(purpose)).update(payload).digest("base64url");
  }

  verify(purpose: string, payload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(purpose, payload));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
