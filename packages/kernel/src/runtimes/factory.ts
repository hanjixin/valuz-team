/** Runtime factory — picks a RuntimePort from `Session.runtime_provider`. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeAvailability, RuntimeProvider } from "@agent-base/protocol";
import { ForkError, type RuntimeFactory, validateApiProtocol } from "../runtime.ts";
import { ClaudeAgentRuntime } from "./claude-agent.ts";
import { CodexRuntime } from "./codex.ts";
import { DeepAgentRuntime } from "./deep-agent.ts";
import { forkThreadFile } from "./thread-file.ts";
import { ValuzAgentRuntime, forkCheckpoint } from "./valuz-agent.ts";

export const createRuntime: RuntimeFactory = (session, deps) => {
  validateApiProtocol(session.runtime_provider, session.model_provider?.api_protocol ?? null);
  switch (session.runtime_provider) {
    case "claude_agent":
      return new ClaudeAgentRuntime(deps);
    case "codex":
      return new CodexRuntime(deps);
    // The hand-written loop, kept beside the library-built one that replaced it as the native runtime.
    case "valuz_agent":
      return new ValuzAgentRuntime(deps);
    default:
      return new DeepAgentRuntime(deps);
  }
};

/**
 * Branch a session's thread on this machine. The native runtime copies its
 * thread now and the fork owns it from here (`runtime_session_id` is set); the
 * Claude runtime branches when the fork takes its first turn, so nothing is
 * done yet (null) and the fork carries where to branch from.
 */
export async function forkThread(
  dataDir: string,
  fork: {
    runtime: RuntimeProvider;
    sourceSessionId: string;
    sessionId: string;
    anchor: Record<string, unknown> | null;
  },
): Promise<{ runtime_session_id: string | null }> {
  switch (fork.runtime) {
    case "claude_agent":
      return { runtime_session_id: null };
    case "codex":
      throw new ForkError("the Codex runtime cannot fork a conversation");
    case "valuz_agent":
      await forkCheckpoint(dataDir, fork.sourceSessionId, fork.sessionId, fork.anchor);
      return { runtime_session_id: fork.sessionId };
    default:
      await forkThreadFile(dataDir, fork.sourceSessionId, fork.sessionId, fork.anchor);
      return { runtime_session_id: fork.sessionId };
  }
}

const exec = promisify(execFile);

async function probe(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 10_000 });
    return stdout.trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

/** What this machine can run — reported to the server when a device links. */
export async function detectRuntimes(): Promise<RuntimeAvailability[]> {
  const codex = await probe("codex");
  return [
    // The Claude Agent SDK bundles its own CLI binary; no PATH lookup needed.
    { runtime: "claude_agent", available: true, detail: "bundled with @anthropic-ai/claude-agent-sdk" },
    { runtime: "codex", available: true, detail: codex ?? "bundled with @openai/codex-sdk" },
    { runtime: "deepagents", available: true, detail: "native (deepagents)" },
    { runtime: "valuz_agent", available: true, detail: "native (hand-written loop)" },
  ];
}
