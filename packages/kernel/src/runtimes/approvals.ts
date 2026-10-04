/** Shared approval bridge — a runtime parks a tool call here until the host decides. */
import { AVAILABLE_DECISIONS_CLARIFYING, AVAILABLE_DECISIONS_EDITABLE, type SubmitAction } from "@agent-base/protocol";
import { type EventSink, makeEvent } from "../sinks.ts";

export type ApprovalSubject = "shell_command" | "file_change" | "mcp_tool_call" | "tool_input" | "clarifying_questions";

export class ApprovalBridge {
  private readonly waiting = new Map<string, (action: SubmitAction) => void>();

  constructor(private getSink: () => EventSink) {}

  /** Emit `requires_action`, wait for the decision, emit `action_resolved`. */
  async request(
    subject: ApprovalSubject,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SubmitAction> {
    const pendingId = crypto.randomUUID();
    const decision = new Promise<SubmitAction>((resolve, reject) => {
      this.waiting.set(pendingId, resolve);
      signal?.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
    });
    await this.getSink().emit(
      makeEvent("requires_action", {
        pending_id: pendingId,
        subject,
        tool_name: toolName,
        input,
        available_decisions:
          subject === "clarifying_questions" ? AVAILABLE_DECISIONS_CLARIFYING : AVAILABLE_DECISIONS_EDITABLE,
      }),
    );
    try {
      const action = await decision;
      await this.getSink().emit(makeEvent("action_resolved", { pending_id: pendingId, decision: action.decision }));
      return action;
    } finally {
      this.waiting.delete(pendingId);
    }
  }

  submit(action: SubmitAction): void {
    const resolve = this.waiting.get(action.pending_id);
    if (!resolve) throw new Error(`no pending action ${action.pending_id}`);
    resolve(action);
  }
}

export const isApproved = (action: SubmitAction): boolean =>
  action.decision === "approve" ||
  action.decision === "approve_with_changes" ||
  action.decision === "approve_for_session" ||
  action.decision === "answer";
