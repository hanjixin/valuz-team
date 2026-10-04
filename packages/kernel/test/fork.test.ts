import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForkError, ValuzAgentRuntime, forkThread } from "../src/index.ts";

describe("forking a thread (the hand-written runtime)", () => {
  let dir: string;
  const checkpoint = (id: string) => path.join(dir, "checkpoints", `${id}.json`);
  const thread = [
    { role: "user", content: "one" },
    { role: "assistant", content: "1" },
    { role: "user", content: "two" },
    { role: "assistant", content: "2" },
  ];
  /** The anchor the native runtime records once its thread holds `length` messages. */
  const anchorAt = async (length: number): Promise<Record<string, unknown> | null> => {
    await writeFile(checkpoint("probe"), JSON.stringify(thread.slice(0, length)));
    const runtime = new ValuzAgentRuntime({
      sink: { emit: async () => undefined },
      dataDir: dir,
      skillsDir: dir,
      skills: [],
    });
    await runtime.prepare({ id: "probe", mcp_servers: [], metadata: {} } as never);
    return runtime.forkAnchor();
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ab-fork-"));
    await mkdir(path.join(dir, "checkpoints"));
    await writeFile(checkpoint("source"), JSON.stringify(thread));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const fork = (runtime: "valuz_agent" | "claude_agent" | "codex" | "deepagents", sessionId: string, anchor = null) =>
    forkThread(dir, { runtime, sourceSessionId: "source", sessionId, anchor });

  it("copies the native runtime's thread, whole or up to an anchor, and hands the copy to the fork", async () => {
    expect(await fork("valuz_agent", "whole")).toEqual({ runtime_session_id: "whole" });
    expect(JSON.parse(await readFile(checkpoint("whole"), "utf8"))).toEqual(thread);

    const anchor = await anchorAt(2);
    expect(anchor).toMatchObject({ history_length: 2 });
    await forkThread(dir, { runtime: "valuz_agent", sourceSessionId: "source", sessionId: "early", anchor });
    expect(JSON.parse(await readFile(checkpoint("early"), "utf8"))).toEqual(thread.slice(0, 2));
    // The source is untouched.
    expect(JSON.parse(await readFile(checkpoint("source"), "utf8"))).toEqual(thread);
  });

  it("refuses an anchor from before the thread was compacted, and a thread that is not on this machine", async () => {
    const anchor = await anchorAt(2);
    const compacted = [{ role: "user", content: "<conversation-summary>…</conversation-summary>" }, ...thread.slice(2)];
    await writeFile(checkpoint("source"), JSON.stringify(compacted));
    const stale = forkThread(dir, { runtime: "valuz_agent", sourceSessionId: "source", sessionId: "stale", anchor });
    await expect(stale).rejects.toThrow(ForkError);
    await expect(stale).rejects.toThrow(/compacted/);
    await expect(
      forkThread(dir, { runtime: "valuz_agent", sourceSessionId: "elsewhere", sessionId: "x", anchor: null }),
    ).rejects.toThrow(/nothing on this device/);
  });

  it("leaves the Claude runtime to branch at the fork's first turn, and says Codex cannot", async () => {
    expect(await fork("claude_agent", "lazy")).toEqual({ runtime_session_id: null });
    await expect(fork("codex", "no")).rejects.toThrow(ForkError);
  });
});
