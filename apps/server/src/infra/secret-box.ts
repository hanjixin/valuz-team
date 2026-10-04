/**
 * AES-256-GCM box for stored credentials (model channel keys, connector and
 * storage secrets). Keys are derived per purpose from APP_SECRET, so a
 * ciphertext copied into another column never decrypts.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export class SecretBox {
  constructor(private readonly appSecret: string) {}

  private key(purpose: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.appSecret, "agent-base", purpose, 32));
  }

  seal(purpose: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(purpose), iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(
      ".",
    );
  }

  open(purpose: string, sealed: string): string {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("malformed secret");
    const decipher = createDecipheriv("aes-256-gcm", this.key(purpose), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}
