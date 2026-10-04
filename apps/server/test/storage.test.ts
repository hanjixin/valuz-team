import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/infra/config.ts";
import { type Storage, createStorage } from "../src/infra/storage.ts";

const base = { DATABASE_URL: "x", REDIS_URL: "y", APP_SECRET: "s".repeat(32) };

/** What every storage must do, whatever is behind it. */
function behaves(storage: () => Storage): void {
  it("stores, returns and removes bytes exactly", async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 0, 42]);
    await storage().put("attachments/org/one", bytes, "application/octet-stream");
    expect((await storage().get("attachments/org/one")).equals(bytes)).toBe(true);
    await storage().put("attachments/org/one", Buffer.from("replaced"));
    expect((await storage().get("attachments/org/one")).toString()).toBe("replaced");
    await storage().remove("attachments/org/one");
    await expect(storage().get("attachments/org/one")).rejects.toThrow();
    await storage().remove("attachments/org/one"); // removing what is gone is not an error
  });
}

describe("local storage", () => {
  let dir: string;
  let storage: Storage;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ab-store-"));
    storage = createStorage(loadConfig({ ...base, STORAGE_DIR: dir }));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  behaves(() => storage);

  it("never writes outside its directory", async () => {
    await expect(storage.put("../escaped", Buffer.from("x"))).rejects.toThrow(/escapes/);
    await expect(storage.get("/etc/passwd")).rejects.toThrow(/escapes/);
    expect(await readdir(path.dirname(dir))).not.toContain("escaped");
  });
});

const hasMinio = (() => {
  try {
    execFileSync("minio", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Runs against a real S3-compatible server when one is installed (`brew install minio`).
describe.skipIf(!hasMinio)("s3 storage", () => {
  let dir: string;
  let minio: ChildProcess;
  let storage: Storage;
  const port = 19000 + Math.floor(Math.random() * 500);
  const s3 = {
    STORAGE_DRIVER: "s3",
    S3_BUCKET: "agent-base-test",
    S3_ENDPOINT: `http://127.0.0.1:${port}`,
    S3_ACCESS_KEY_ID: "minioadmin",
    S3_SECRET_ACCESS_KEY: "minioadmin",
    S3_FORCE_PATH_STYLE: "1",
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ab-minio-"));
    minio = spawn(
      "minio",
      ["server", dir, "--address", `127.0.0.1:${port}`, "--console-address", `127.0.0.1:${port + 500}`],
      { stdio: "ignore" },
    );
    const client = new S3Client({
      region: "us-east-1",
      endpoint: s3.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: s3.S3_ACCESS_KEY_ID, secretAccessKey: s3.S3_SECRET_ACCESS_KEY },
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: s3.S3_BUCKET }));
        break;
      } catch (err) {
        if (attempt > 50) throw err;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    storage = createStorage(loadConfig({ ...base, ...s3 }));
  });
  afterAll(async () => {
    minio?.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });
  behaves(() => storage);
});

describe("storage configuration", () => {
  it("refuses s3 without a bucket", () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET/);
  });
});
