/** StorePort — persistence interface for Session, Message, and Event storage. */
import type { KernelEvent, Message, Session, StoredEvent } from "@agent-base/protocol";

export interface AppendEventOptions {
  /** Idempotency key for at-least-once remote writes: a retry never inserts twice. */
  requestId?: string;
}

export interface StorePort {
  saveSession(session: Session): Promise<void>;
  loadSession(userId: string, sessionId: string): Promise<Session | null>;
  /** `userId = null` lists across every owner — reserved for startup sweeps. */
  listSessions(userId: string | null, filter?: { status?: string }): Promise<Session[]>;
  saveMessage(userId: string, message: Message): Promise<void>;
  loadMessage(userId: string, messageId: string): Promise<Message | null>;
  appendEvent(
    userId: string,
    sessionId: string,
    messageId: string,
    event: KernelEvent,
    options?: AppendEventOptions,
  ): Promise<number | null>;
  getEventsAfter(
    userId: string,
    sessionId: string,
    afterSeq: number,
    limit: number,
    types?: readonly string[],
  ): Promise<StoredEvent[]>;
}

/** In-process store — unit tests and the standalone (no-server) host mode. */
export class MemoryStore implements StorePort {
  readonly sessions = new Map<string, Session>();
  readonly messages = new Map<string, Message>();
  readonly events: StoredEvent[] = [];
  private readonly seenRequests = new Map<string, number>();
  private seq = 0;

  async saveSession(session: Session): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async loadSession(userId: string, sessionId: string): Promise<Session | null> {
    const s = this.sessions.get(sessionId);
    return s && s.user_id === userId ? structuredClone(s) : null;
  }

  async listSessions(userId: string | null, filter?: { status?: string }): Promise<Session[]> {
    return [...this.sessions.values()]
      .filter((s) => userId === null || s.user_id === userId)
      .filter((s) => !filter?.status || s.status === filter.status)
      .sort((a, b) => b.created_at - a.created_at)
      .map((s) => structuredClone(s));
  }

  async saveMessage(_userId: string, message: Message): Promise<void> {
    this.messages.set(message.id, structuredClone(message));
  }

  async loadMessage(_userId: string, messageId: string): Promise<Message | null> {
    const m = this.messages.get(messageId);
    return m ? structuredClone(m) : null;
  }

  async appendEvent(
    _userId: string,
    sessionId: string,
    messageId: string,
    event: KernelEvent,
    options?: AppendEventOptions,
  ): Promise<number | null> {
    if (options?.requestId) {
      const prior = this.seenRequests.get(options.requestId);
      if (prior !== undefined) return prior;
    }
    const seq = ++this.seq;
    this.events.push({
      seq,
      session_id: sessionId,
      message_id: messageId,
      type: event.type,
      data: structuredClone(event.data),
      timestamp: event.timestamp,
      event_uid: options?.requestId ?? null,
    });
    if (options?.requestId) this.seenRequests.set(options.requestId, seq);
    return seq;
  }

  async getEventsAfter(
    _userId: string,
    sessionId: string,
    afterSeq: number,
    limit: number,
    types?: readonly string[],
  ): Promise<StoredEvent[]> {
    return this.events
      .filter((e) => e.session_id === sessionId && e.seq > afterSeq)
      .filter((e) => !types || types.includes(e.type))
      .slice(0, limit);
  }
}
