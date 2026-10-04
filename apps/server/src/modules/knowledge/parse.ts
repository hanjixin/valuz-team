/**
 * Turning an uploaded file into searchable text, off the request path. Jobs
 * wait in a Redis queue (BullMQ), so any replica may parse what another accepted
 * and a restart loses nothing. Parsers and the splitter are third-party.
 */
import path from "node:path";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Queue, Worker } from "bullmq";
import { parseOffice } from "officeparser";
import type { Ctx } from "../../infra/context.ts";
import * as notifications from "../notifications/service.ts";
import * as repo from "./repo.ts";

const QUEUE = "kb-parse";
const TEXT_EXTENSIONS = new Set(
  ".md .markdown .txt .csv .tsv .json .yaml .yml .html .htm .xml .log .rst .tex".split(" "),
);
const OFFICE_EXTENSIONS = new Set(".pdf .docx .pptx .xlsx .odt .odp .ods .rtf".split(" "));
export const SUPPORTED_EXTENSIONS = [...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS];
export const supported = (filename: string): boolean =>
  SUPPORTED_EXTENSIONS.includes(path.extname(filename).toLowerCase());

interface ParseJob {
  documentId: string;
  taskId: string;
}

const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1200, chunkOverlap: 150 });
const queues = new WeakMap<Ctx, Queue<ParseJob>>();

async function extract(filename: string, bytes: Buffer): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return bytes.toString("utf8");
  const ast = await parseOffice(bytes);
  // The Markdown rendering opens with the file's metadata as front matter, which is not the document's text.
  return String((await ast.to("md")).value).replace(/^---\n[\s\S]*?\n---\n+/, "");
}

async function parse(ctx: Ctx, job: ParseJob): Promise<void> {
  const doc = await repo.documentForParsing(ctx.db, job.documentId);
  if (!doc) return void (await repo.advanceTask(ctx.db, job.taskId, false)); // deleted while it waited
  await repo.setStatus(ctx.db, [doc.id], "processing");
  try {
    const raw = await extract(doc.filename, await ctx.storage.get(doc.storage_key));
    // PostgreSQL text cannot hold NUL bytes; some PDFs carry them.
    const text = raw.replaceAll("\u0000", "").trim();
    if (!text) throw new Error("no text could be extracted (a scanned document needs OCR, which is not available)");
    await repo.storeParsed(ctx.db, doc.id, text, await splitter.splitText(text));
    await repo.advanceTask(ctx.db, job.taskId, false);
  } catch (err) {
    // A document that cannot be parsed is a result, not a job to retry.
    const reason = (err as Error).message.slice(0, 500);
    await repo.setStatus(ctx.db, [doc.id], "failed", reason);
    await repo.advanceTask(ctx.db, job.taskId, true);
    await notifications.notify(
      ctx,
      { orgId: doc.org_id, userId: doc.owner_id },
      {
        kind: "document_failed",
        title: `文档解析失败：${doc.filename}`,
        body: reason.slice(0, 300),
        route: "/knowledge",
      },
    );
  }
}

/** Start parsing what is queued. Returns how to stop. */
export function start(ctx: Ctx): () => Promise<void> {
  // BullMQ blocks on its connection, so it gets its own rather than the server's.
  const connection = ctx.redis.duplicate();
  connection.on("error", () => undefined); // retried by ioredis; reported once by the server's own connection
  const queue = new Queue<ParseJob>(QUEUE, { connection: ctx.redis });
  const worker = new Worker<ParseJob>(QUEUE, (job) => parse(ctx, job.data), { connection, concurrency: 2 });
  queue.on("error", (err) => ctx.log(err, "knowledge base queue"));
  worker.on("error", (err) => ctx.log(err, "knowledge base parser"));
  worker.on("failed", (job, err) => ctx.log(err, `document ${job?.data.documentId ?? "?"}: parsing crashed`));
  queues.set(ctx, queue);
  return async () => {
    // Closing waits for Redis to answer; when Redis is what went away, shutdown must not wait with it.
    const closed = Promise.allSettled([worker.close(true), queue.close()]);
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
    void worker.disconnect().catch(() => undefined);
    connection.disconnect();
  };
}

export async function enqueue(ctx: Ctx, taskId: string, documentIds: string[]): Promise<void> {
  const queue = queues.get(ctx);
  if (!queue) throw new Error("the knowledge base parser was not started");
  await queue.addBulk(
    documentIds.map((documentId) => ({
      name: "parse",
      data: { documentId, taskId },
      opts: { removeOnComplete: true, removeOnFail: 100 },
    })),
  );
}
