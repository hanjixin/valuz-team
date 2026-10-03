import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { MarkdownContent, ToolCallCard } from "@valuz/ui";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { del, post, put, stream } from "../api.ts";
import type { Me } from "../main.tsx";
import { ShareDialog } from "../share.tsx";
import { type Item, type Timeline, applyEvent, emptyTimeline } from "../timeline.ts";
import { Btn, Badge, Empty, ErrorLine, Page, PermissionBadge, can, timeAgo, useAction, useLoad, useStickToBottom } from "../ui.tsx";

export function SessionsPage() {
  const sessions = useLoad<{ data: any[] }>("/v1/sessions?limit=100");
  return (
    <Page title="会话">
      <ErrorLine>{sessions.error}</ErrorLine>
      <div className="list">
        {sessions.data?.data.length === 0 ? <Empty>还没有会话。到项目里选一个智能体开始。</Empty> : null}
        {sessions.data?.data.map((s) => (
          <Link className="card item" key={s.id} to={`/sessions/${s.id}`} style={{ color: "inherit" }}>
            <div className="grow"><span className="title">{s.title || s.agent_name}</span> <span className="muted small">{s.agent_name} · {s.owner_name}</span></div>
            {s.status === "running" ? <Badge tone="info">运行中</Badge> : null}<span className="muted small">{timeAgo(s.updated_at)}</span>
          </Link>
        ))}
      </div>
    </Page>
  );
}

const pretty = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** The one argument worth showing on a collapsed tool card. */
function toolSubtitle(input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const value = i["command"] ?? i["file_path"] ?? i["path"] ?? i["subtask_key"] ?? i["pattern"] ?? i["query"];
  return typeof value === "string" ? value.slice(0, 120) : undefined;
}

function resultText(result: unknown): string {
  if (Array.isArray(result)) return result.map((b: any) => (b?.type === "text" ? b.text : pretty(b))).join("\n");
  return pretty(result ?? "");
}

export function ItemView({ item, onDecide, canControl }: { item: Item; onDecide: (pendingId: string, decision: string) => void; canControl: boolean }) {
  switch (item.kind) {
    case "user":
      return <div className="msg user">{item.text}</div>;
    case "assistant":
      return <div className="msg"><MarkdownContent content={item.text} mode={item.streaming ? "streaming" : "static"} isAnimating={item.streaming} /></div>;
    case "thinking":
      return <details className="muted small"><summary>思考过程</summary><pre style={{ whiteSpace: "pre-wrap" }}>{item.text}</pre></details>;
    case "tool":
      return (
        <div style={{ maxWidth: 820 }}>
          <ToolCallCard
            tc={{
              id: item.id,
              kind: /bash|shell|exec/i.test(item.name) ? "bash" : /fetch|search|web/i.test(item.name) ? "fetch" : "file",
              title: item.name,
              subtitle: toolSubtitle(item.input),
              status: item.result === undefined ? "running" : item.isError ? "error" : "success",
              input: pretty(item.input),
              output: item.result === undefined ? undefined : resultText(item.result),
            }}
          />
        </div>
      );
    case "approval":
      return (
        <div className="approval">
          <div><strong>需要确认</strong> <span className="mono">{item.toolName}</span></div>
          <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{pretty(item.input)}</pre>
          {item.resolved ? <Badge>{({ approve: "已批准", reject: "已拒绝", interrupted: "已中断", expired: "已过期" } as Record<string, string>)[item.resolved] ?? item.resolved}</Badge> : canControl ? (
            <div className="row">
              <Btn className="primary" onClick={() => onDecide(item.pendingId, "approve")}>批准</Btn>
              {item.options.includes("approve_for_session") ? <Btn onClick={() => onDecide(item.pendingId, "approve_for_session")}>本会话内始终批准</Btn> : null}
              <Btn className="danger" onClick={() => onDecide(item.pendingId, "reject")}>拒绝</Btn>
            </div>
          ) : <span className="muted small">等待有控制权限的人确认</span>}
        </div>
      );
    case "error":
      return <div className="error msg">{item.text}</div>;
    case "note":
      return <div className="msg note">— {item.text} —</div>;
  }
}

/** Live conversation for one session. Also embedded in the task view for the lead and members. */
export function useConversation({ sessionId, onTurnEnd }: { sessionId: string; onTurnEnd?: () => void }) {
  const [timeline, setTimeline] = useState<Timeline>(emptyTimeline);
  useEffect(() => {
    setTimeline(emptyTimeline());
    return stream(`/v1/sessions/${sessionId}/events/stream`, 0, (e) => setTimeline((t) => applyEvent(t, e)));
  }, [sessionId]);
  useEffect(() => {
    if (timeline.turnsEnded > 0) onTurnEnd?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline.turnsEnded]);
  return timeline;
}

export function SessionPage({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const session = useLoad<any>(`/v1/sessions/${id}`);
  const messages = useLoad<{ data: any[] }>(`/v1/sessions/${id}/messages`);
  const queue = useLoad<{ data: any[] }>(`/v1/sessions/${id}/queue`);
  const timeline = useConversation({ sessionId: id, onTurnEnd: () => { void session.reload(); void messages.reload(); void queue.reload(); } });
  const [text, setText] = useState("");
  const [sharing, setSharing] = useState(false);
  const [sending, setSending] = useState(false);
  const action = useAction();
  const scroll = useStickToBottom<HTMLDivElement>(timeline.items);
  const s = session.data;
  // Who sent each turn — it matters once teammates can drive your session.
  const senders = useMemo(() => new Map((messages.data?.data ?? []).map((m) => [m.id, m.actor_name as string])), [messages.data]);
  const ratings = useMemo(() => new Map((messages.data?.data ?? []).map((m) => [m.id, m.my_rating as string | null])), [messages.data]);
  // Feedback is given on a turn, so it sits under the turn's last answer.
  const lastAnswer = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of timeline.items) if (item.kind === "assistant" && item.messageId) map.set(item.messageId, item.key);
    return map;
  }, [timeline.items]);
  if (session.error) return <Page title="会话"><ErrorLine>{session.error}</ErrorLine></Page>;
  if (!s) return <Page title="会话"><span className="muted">加载中…</span></Page>;

  const canControl = can(s.permission, "control");
  const running = s.status === "running";
  const queued = queue.data?.data ?? [];
  const send = () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    void action
      .run(async () => {
        // While a turn is running the message waits in the queue and is sent when the turn ends.
        if (s.status === "running") await post(`/v1/sessions/${id}/queue`, { text: body });
        else await post(`/v1/sessions/${id}/messages`, { text: body });
        setText("");
        await Promise.all([session.reload(), queue.reload()]);
      })
      .finally(() => setSending(false));
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } };
  const decide = (pending_id: string, decision: string) => void action.run(() => post(`/v1/sessions/${id}/actions`, { pending_id, decision }));
  const task = s.metadata?.valuz?.task;

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="grow">
          <div className="title">{s.title || s.agent_config.name}</div>
          <div className="muted small">{s.agent_config.name} · {s.runtime_provider}{s.model ? ` · ${s.model}` : ""} · <span className="mono">{s.cwd}</span></div>
        </div>
        {task ? <Link to={`/tasks/${task.task_id}`}><Badge tone="info">任务的{task.role === "lead" ? " lead" : "成员"}</Badge></Link> : null}
        {s.owner_id !== me.user.id ? <Badge tone="warn">他人的会话</Badge> : null}
        <PermissionBadge value={s.permission} />
        {s.status === "running" && canControl ? <Btn className="danger" onClick={() => void action.run(() => post(`/v1/sessions/${id}/interrupt`))}>中断</Btn> : null}
        {canControl && s.runtime_provider !== "codex" && s.runtime_session_id && s.status !== "running" ? (
          <Btn onClick={() => void action.run(async () => nav(`/sessions/${(await post(`/v1/sessions/${id}/fork`)).id}`))}>分叉</Btn>
        ) : null}
        {can(s.permission, "admin") ? <Btn onClick={() => setSharing(true)}>共享</Btn> : null}
      </header>
      <div className="chat-body" ref={scroll.ref} onScroll={scroll.onScroll}>
        {timeline.items.length === 0 ? <Empty>发一条消息开始。会话在设备上执行，这里实时显示。</Empty> : null}
        {timeline.items.map((item) => (
          <div key={item.key} style={{ display: "grid" }}>
            {item.kind === "user" && senders.get(item.messageId) && senders.get(item.messageId) !== me.user.name ? <span className="muted small" style={{ justifySelf: "end" }}>{senders.get(item.messageId)}</span> : null}
            <ItemView item={item} onDecide={decide} canControl={canControl} />
            {item.kind === "assistant" && !item.streaming && lastAnswer.get(item.messageId) === item.key ? (
              <div className="row">
                {(["up", "down"] as const).map((rating) => {
                  const mine = ratings.get(item.messageId) === rating;
                  const Icon = rating === "up" ? ThumbsUp : ThumbsDown;
                  return (
                    <button key={rating} type="button" aria-pressed={mine} aria-label={rating === "up" ? "有帮助" : "没帮助"} style={{ cursor: "pointer", color: mine ? "var(--accent)" : "var(--muted)" }}
                      onClick={() => void action.run(async () => { await put(`/v1/sessions/${id}/feedback`, { message_id: item.messageId, rating: mine ? null : rating }); await messages.reload(); })}>
                      <Icon size={14} />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ))}
        {timeline.todos?.length ? (
          <div className="card small" style={{ maxWidth: 820 }}>{timeline.todos.map((t, i) => <div key={i}>{t.status === "completed" ? "☑" : t.status === "in_progress" ? "▶" : "☐"} {t.content}</div>)}</div>
        ) : null}
      </div>
      <footer className="chat-foot">
        <ErrorLine>{action.error}</ErrorLine>
        {queued.length > 0 ? (
          <div className="stack">
            <div className="row small muted">
              <span className="grow">排队中的消息（{queued.length}）</span>
              {!running && canControl ? <Btn className="ghost" onClick={() => void action.run(async () => { await post(`/v1/sessions/${id}/queue/resume`); await Promise.all([session.reload(), queue.reload()]); })}>继续发送</Btn> : null}
            </div>
            {queued.map((q) => (
              <div className="row small" key={q.id}>
                <span className="grow" style={{ overflowWrap: "anywhere" }}>{q.text}</span>
                <span className="muted">{q.actor_name}</span>
                {canControl ? <Btn className="ghost" aria-label="取消这条排队消息" onClick={() => void action.run(async () => { await del(`/v1/sessions/${id}/queue/${q.id}`); await queue.reload(); })}>×</Btn> : null}
              </div>
            ))}
          </div>
        ) : null}
        {canControl ? (
          <div className="row">
            <textarea className="grow" rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={running ? "正在运行 — 现在发送的消息会排队，回合结束后依次发出" : "输入消息，Enter 发送，Shift+Enter 换行"} />
            <Btn className="primary" disabled={sending || !text.trim()} onClick={send}>{running ? "排队" : "发送"}</Btn>
          </div>
        ) : <div className="muted small">你对这个会话只有查看权限。</div>}
      </footer>
      {sharing ? <ShareDialog base={`/v1/sessions/${id}`} kind="session" title={s.title || s.agent_config.name} onClose={() => setSharing(false)} /> : null}
    </div>
  );
}

