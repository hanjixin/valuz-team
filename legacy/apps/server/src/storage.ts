/**
 * Cloud storage. Each organization configures its own bucket (any
 * S3-compatible service: AWS S3, Tencent COS, Aliyun OSS, MinIO, R2); until it
 * does, files land on the server's local disk. Clients never proxy bytes
 * through the API for S3 — they get a presigned URL.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "./config.ts";
import type { SecretBox } from "./crypto.ts";
import type { Db } from "./db.ts";
import { badRequest, forbidden } from "./http.ts";

export interface S3Target {
  driver: "s3";
  endpoint: string | null;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}
export type StorageTarget = { driver: "local" } | S3Target;

export interface FileRef {
  id: string;
  driver: string;
  storage_key: string;
  content_type: string;
  org_id: string;
}

const URL_TTL_S = 900;

export class StorageService {
  private readonly clients = new Map<string, S3Client>();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly config: Config,
  ) {}

  /** The org's configured target, or the server's local disk. */
  async resolve(orgId: string): Promise<StorageTarget> {
    const row = await this.db.one<Record<string, string | boolean | null>>("SELECT * FROM storage_configs WHERE org_id = $1", [orgId]);
    if (!row || row["driver"] === "local") return { driver: "local" };
    return {
      driver: "s3",
      endpoint: (row["endpoint"] as string | null) || null,
      region: (row["region"] as string | null) || "us-east-1",
      bucket: row["bucket"] as string,
      prefix: (row["prefix"] as string) ?? "",
      accessKeyId: row["access_key_id"] as string,
      secretAccessKey: this.box.open("storage", row["secret_enc"] as string),
      forcePathStyle: row["force_path_style"] === true,
    };
  }

  private client(t: S3Target): S3Client {
    const cacheKey = JSON.stringify([t.endpoint, t.region, t.accessKeyId, t.secretAccessKey, t.forcePathStyle]);
    let client = this.clients.get(cacheKey);
    if (!client) {
      client = new S3Client({
        region: t.region,
        ...(t.endpoint ? { endpoint: t.endpoint } : {}),
        forcePathStyle: t.forcePathStyle,
        credentials: { accessKeyId: t.accessKeyId, secretAccessKey: t.secretAccessKey },
      });
      this.clients.set(cacheKey, client);
    }
    return client;
  }

  /** Object key for a new file. The org id is always the first path segment. */
  newKey(target: StorageTarget, orgId: string, fileId: string, name: string): string {
    const safe = name.replace(/[^\w.\-]+/g, "_").slice(-120);
    const prefix = target.driver === "s3" && target.prefix ? `${target.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
    return `${prefix}${orgId}/${fileId}/${safe}`;
  }

  private localPath(key: string): string {
    const root = path.join(this.config.DATA_DIR, "files");
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw badRequest("invalid storage key");
    return full;
  }

  private localUrl(file: FileRef, op: "put" | "get"): string {
    const exp = Math.floor(Date.now() / 1000) + URL_TTL_S;
    const sig = this.box.sign("file-url", `${op}:${file.id}:${exp}`);
    return `${this.config.PUBLIC_URL}/v1/files/${file.id}/content?op=${op}&exp=${exp}&sig=${sig}`;
  }

  /** Check a local-storage link's signature and expiry. */
  verifyLocalUrl(fileId: string, op: "put" | "get", exp: string, sig: string): void {
    if (!(Number(exp) > Date.now() / 1000) || !this.box.verify("file-url", `${op}:${fileId}:${exp}`, sig)) {
      throw forbidden("this link is invalid or has expired");
    }
  }

  private async targetFor(file: FileRef): Promise<StorageTarget> {
    if (file.driver === "local") return { driver: "local" };
    const target = await this.resolve(file.org_id);
    if (target.driver !== "s3") throw badRequest("this file's storage is no longer configured", "storage_unconfigured");
    return target;
  }

  async uploadUrl(file: FileRef): Promise<{ method: "PUT"; url: string; headers: Record<string, string> }> {
    const target = await this.targetFor(file);
    const headers = { "content-type": file.content_type };
    if (target.driver === "local") return { method: "PUT", url: this.localUrl(file, "put"), headers };
    const command = new PutObjectCommand({ Bucket: target.bucket, Key: file.storage_key, ContentType: file.content_type });
    return { method: "PUT", url: await getSignedUrl(this.client(target), command, { expiresIn: URL_TTL_S }), headers };
  }

  async downloadUrl(file: FileRef): Promise<string> {
    const target = await this.targetFor(file);
    if (target.driver === "local") return this.localUrl(file, "get");
    const command = new GetObjectCommand({ Bucket: target.bucket, Key: file.storage_key });
    return getSignedUrl(this.client(target), command, { expiresIn: URL_TTL_S });
  }

  /** Size of the stored object, or null when nothing was uploaded. */
  async size(file: FileRef): Promise<number | null> {
    const target = await this.targetFor(file);
    if (target.driver === "local") {
      return stat(this.localPath(file.storage_key)).then((s) => s.size, () => null);
    }
    try {
      const head = await this.client(target).send(new HeadObjectCommand({ Bucket: target.bucket, Key: file.storage_key }));
      return head.ContentLength ?? 0;
    } catch {
      return null;
    }
  }

  async remove(file: FileRef): Promise<void> {
    const target = await this.targetFor(file);
    if (target.driver === "local") {
      await rm(this.localPath(file.storage_key), { force: true });
    } else {
      await this.client(target).send(new DeleteObjectCommand({ Bucket: target.bucket, Key: file.storage_key }));
    }
  }

  async writeLocal(file: FileRef, body: Readable): Promise<void> {
    const target = this.localPath(file.storage_key);
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(body, createWriteStream(target));
  }

  /** The whole object in memory — for server-side processing (document parsing). */
  async read(file: FileRef): Promise<Buffer> {
    const target = await this.targetFor(file);
    if (target.driver === "local") return readFile(this.localPath(file.storage_key));
    const res = await this.client(target).send(new GetObjectCommand({ Bucket: target.bucket, Key: file.storage_key }));
    if (!res.Body) throw new Error("the stored object is empty");
    return Buffer.from(await res.Body.transformToByteArray());
  }

  readLocal(file: FileRef): Readable {
    return createReadStream(this.localPath(file.storage_key));
  }

  /** Round-trip a probe object so a bad bucket/key is caught at save time. */
  async test(target: StorageTarget): Promise<void> {
    if (target.driver === "local") return;
    const client = this.client(target);
    const Key = `${target.prefix ? `${target.prefix.replace(/^\/+|\/+$/g, "")}/` : ""}.agent-base-probe-${crypto.randomUUID()}`;
    await client.send(new PutObjectCommand({ Bucket: target.bucket, Key, Body: "ok" }));
    await client.send(new HeadObjectCommand({ Bucket: target.bucket, Key }));
    await client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key }));
  }
}
