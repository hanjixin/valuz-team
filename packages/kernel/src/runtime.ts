/** RuntimePort — the single runtime interface the orchestrator depends on. */
import type {
  ApiProtocol,
  RuntimeProvider,
  Session,
  SkillBundle,
  SubmitAction,
  UserMessage,
} from "@agent-base/protocol";
import type { EventSink } from "./sinks.ts";
import type { MaterializedSkill } from "./skills.ts";

export interface RuntimePort {
  /** Replace the event sink (each turn binds a fresh per-message pipeline). */
  updateSink(sink: EventSink): void;
  /** Warm persistent client resources without sending a model turn. Idempotent. */
  prepare(session: Session): Promise<void>;
  /**
   * Execute one turn. Events are pushed via the sink; the runtime sets
   * `session.status` / `session.stop_reason` / `session.runtime_session_id` in
   * place and emits exactly one terminal `session_idle` or `session_error`.
   */
  run(session: Session, userMessage: UserMessage): Promise<void>;
  submitAction(action: SubmitAction): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeDeps {
  sink: EventSink;
  /** Where runtime-private state (checkpoints) lives on this machine. */
  dataDir: string;
  /** This session's materialized skills (see `skills.ts`); empty when none. */
  skillsDir: string;
  skills: readonly MaterializedSkill[];
}

export type RuntimeFactory = (session: Session, deps: RuntimeDeps) => RuntimePort;

export const ALLOWED_PROTOCOLS_BY_RUNTIME: Record<RuntimeProvider, readonly ApiProtocol[]> = {
  claude_agent: ["anthropic"],
  codex: ["openai_response"],
  valuz_agent: ["openai_completion"],
  deepagents: ["openai_completion"],
};

/** `deepagents` rows from the Python build run on the native Valuz runtime. */
export const canonicalRuntime = (runtime: RuntimeProvider): RuntimeProvider =>
  runtime === "deepagents" ? "valuz_agent" : runtime;

export class RuntimeConfigError extends Error {}

export function validateApiProtocol(runtime: RuntimeProvider, protocol: ApiProtocol | null): void {
  if (protocol === null) return;
  const allowed = ALLOWED_PROTOCOLS_BY_RUNTIME[runtime];
  if (!allowed.includes(protocol)) {
    throw new RuntimeConfigError(
      `api_protocol=${protocol} is not supported for runtime_provider=${runtime}; allowed: ${allowed.join(", ")}`,
    );
  }
}

/** Skills handed to a turn alongside the session (resolved by the server). */
export interface TurnExtras {
  skillBundles?: SkillBundle[];
}

/** Where a forked session's history comes from, until its own first turn creates its native thread. */
export interface ForkSource {
  session_id: string;
  native_session_id: string;
}

export const forkSourceOf = (session: { metadata: Record<string, unknown> }): ForkSource | null => {
  const fork = (session.metadata["valuz"] as { fork?: Partial<ForkSource> } | undefined)?.fork;
  return fork?.session_id && fork.native_session_id ? { session_id: fork.session_id, native_session_id: fork.native_session_id } : null;
};
