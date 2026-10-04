/**
 * RemoteStore — the kernel's StorePort when the cloud is the system of record.
 * Sessions arrive with each `session.run`; every write is forwarded over the
 * device link (and retried until acked), so the host persists nothing but
 * runtime checkpoints.
 */
import type { StorePort } from "@agent-base/kernel";
import type { KernelEvent, Message, Session, SessionPatch, StoredEvent } from "@agent-base/protocol";
import type { DeviceLink } from "./link.ts";

const PATCH_KEYS = ["status", "stop_reason", "runtime_session_id", "todos", "mode"] as const;

export class RemoteStore implements StorePort {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly link: DeviceLink) {}

  /** Adopt the session snapshot the server dispatched for this turn. */
  adopt(session: Session): void {
    // The native thread id is host-side truth: never let an older server copy regress it.
    const prior = this.sessions.get(session.id);
    this.sessions.set(session.id, {
      ...structuredClone(session),
      runtime_session_id: session.runtime_session_id ?? prior?.runtime_session_id ?? null,
    });
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async saveSession(session: Session): Promise<void> {
    const prior = this.sessions.get(session.id);
    const patch: Record<string, unknown> = {};
    for (const key of PATCH_KEYS) {
      if (!prior || JSON.stringify(prior[key]) !== JSON.stringify(session[key])) patch[key] = session[key];
    }
    this.sessions.set(session.id, structuredClone(session));
    if (Object.keys(patch).length > 0) {
      this.link.sendState({ t: "session.patch", session_id: session.id, patch: patch as SessionPatch });
    }
  }

  async loadSession(_userId: string, sessionId: string): Promise<Session | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map((s) => structuredClone(s));
  }

  async saveMessage(_userId: string, message: Message): Promise<void> {
    this.link.sendState({ t: "message.upsert", message: structuredClone(message) });
  }

  async loadMessage(): Promise<Message | null> {
    return null;
  }

  async appendEvent(
    _userId: string,
    sessionId: string,
    messageId: string,
    event: KernelEvent,
    options?: { requestId?: string },
  ): Promise<number | null> {
    this.link.sendState({
      t: "event",
      uid: options?.requestId,
      session_id: sessionId,
      message_id: messageId,
      type: event.type,
      data: event.data,
      timestamp: event.timestamp,
    });
    return null; // the server assigns the global seq
  }

  async getEventsAfter(): Promise<StoredEvent[]> {
    return [];
  }
}
