/**
 * A session's thread, kept in one file on this machine. LangGraph's own
 * in-memory checkpointer does the bookkeeping; this loads it from the file and
 * writes it back when a turn ends. (The library's durable savers are built on
 * native database modules, which the desktop app — running the host under
 * Electron's Node — could not load.)
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { ForkError } from "../runtime.ts";

/** How many turns back a conversation can still be forked from. */
const KEPT_TURNS = 30;

/** Each session has a file to itself, so the thread inside it needs no name of its own. */
export const THREAD = "main";

export const threadFile = (dataDir: string, sessionId: string): string =>
  path.join(dataDir, "threads", `${sessionId}.json`);

interface Stored {
  storage: MemorySaver["storage"];
  writes: MemorySaver["writes"];
  /** Set on a fork made from one of the source's turns: where its first turn branches from. */
  branch_from?: string | null;
  turn_ends?: string[];
}

// Checkpoints are bytes; JSON carries them as base64.
const pack = (_key: string, value: unknown): unknown =>
  value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString("base64") } : value;
const unpack = (_key: string, value: unknown): unknown =>
  value && typeof value === "object" && typeof (value as { $bytes?: unknown }).$bytes === "string"
    ? new Uint8Array(Buffer.from((value as { $bytes: string }).$bytes, "base64"))
    : value;

const load = async (file: string): Promise<Stored | null> => {
  const raw = await readFile(file, "utf8").catch(() => null);
  return raw ? (JSON.parse(raw, unpack) as Stored) : null;
};

async function store(file: string, stored: Stored): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename: a crash mid-write must not corrupt the thread.
  await writeFile(`${file}.tmp`, JSON.stringify(stored, pack));
  await rename(`${file}.tmp`, file);
}

const checkpointsOf = (stored: Pick<Stored, "storage">): string[] => Object.keys(stored.storage[THREAD]?.[""] ?? {});

export class FileCheckpointer extends MemorySaver {
  private branchFrom: string | null = null;
  /** The checkpoints recent turns ended at, oldest first. */
  private turnEnds: string[] = [];

  private constructor(private readonly file: string) {
    super();
  }

  /** Open a session's thread — its own, or failing that a copy of the one it was forked from. */
  static async open(file: string, forkedFrom: string | null): Promise<FileCheckpointer> {
    const saver = new FileCheckpointer(file);
    const stored = (await load(file)) ?? (forkedFrom ? await load(forkedFrom) : null);
    if (stored) {
      saver.storage = stored.storage;
      saver.writes = stored.writes;
      saver.branchFrom = stored.branch_from ?? null;
      saver.turnEnds = stored.turn_ends ?? [];
    }
    return saver;
  }

  /** The newest point of the thread: what a later fork of this turn branches from. */
  latest(): string | null {
    // Checkpoint ids are time-ordered.
    return checkpointsOf(this).sort().at(-1) ?? null;
  }

  /** How the next turn continues: from the tail, or — once, for a fresh fork — from the point it branched at. */
  resumeFrom(): { checkpoint_id?: string } {
    const from = this.branchFrom;
    this.branchFrom = null;
    return from ? { checkpoint_id: from } : {};
  }

  /**
   * Write the thread to its file. Called when a turn ends, which is also when
   * the thread is trimmed: the library records a checkpoint at every step, each
   * holding the whole conversation, and only the points a turn ended at are
   * ever returned to (the tail to continue from, earlier ones to fork from).
   */
  save(): Promise<void> {
    const tail = this.latest();
    if (tail) {
      this.turnEnds = [...this.turnEnds.filter((id) => id !== tail), tail].slice(-KEPT_TURNS);
      const kept = new Set(this.turnEnds);
      if (this.branchFrom) kept.add(this.branchFrom);
      const thread = this.storage[THREAD] ?? {};
      // What sub-agents checkpointed under their own namespaces only mattered while the turn ran.
      for (const namespace of Object.keys(thread)) if (namespace !== "") delete thread[namespace];
      for (const id of Object.keys(thread[""] ?? {})) if (!kept.has(id)) delete thread[""]?.[id];
      for (const key of Object.keys(this.writes)) {
        const [, namespace, id] = JSON.parse(key) as [string, string, string];
        if (namespace !== "" || !kept.has(id)) delete this.writes[key];
      }
    }
    return store(this.file, {
      storage: this.storage,
      writes: this.writes,
      branch_from: this.branchFrom,
      turn_ends: this.turnEnds,
    });
  }
}

/**
 * Give `sessionId` a thread of its own that starts as a copy of `sourceId`'s —
 * all of it, or up to the point an earlier turn recorded.
 */
export async function forkThreadFile(
  dataDir: string,
  sourceId: string,
  sessionId: string,
  anchor: Record<string, unknown> | null,
): Promise<void> {
  const stored = await load(threadFile(dataDir, sourceId));
  if (!stored) throw new ForkError("this conversation has nothing on this device to fork from");
  const at = anchor ? String(anchor["checkpoint_id"] ?? "") : null;
  if (at !== null && !checkpointsOf(stored).includes(at))
    throw new ForkError("that point of the conversation is no longer kept on this device; fork the whole conversation");
  await store(threadFile(dataDir, sessionId), { ...stored, branch_from: at });
}
