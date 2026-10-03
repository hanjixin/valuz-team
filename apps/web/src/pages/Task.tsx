import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { post, stream } from "../api.ts";
import { Btn, Badge, ErrorLine, Page, can, useAction, useLoad, useStickToBottom } from "../ui.tsx";
import { TASK_LABEL, TASK_TONE } from "./Projects.tsx";
import { ItemView, useConversation } from "./Session.tsx";

const NODE_LABEL: Record<string, string> = {
  planned: "待派发", in_progress: "执行中", in_review: "待评审", rework: "返工", done: "已通过", paused: "已暂停", failed: "失败",
};
const NODE_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  planned: "muted", in_progress: "info", in_review: "warn", rework: "warn", done: "ok", paused: "muted", failed: "bad",
};

/** One line per timeline event, in the user's words rather than the event's type. */
function describe(e: any): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case "task_drafted": return "创建了任务";
    case "task_started": return `任务开始，lead：${p.lead_agent}`;
    case "plan_created": return `制定计划：${(p.subtasks ?? []).map((s: any) => s.title).join("、")}`;
    case "plan_modified": return `修改计划${p.added?.length ? `，新增 ${p.added.join("、")}` : ""}${p.updated?.length ? `，更新 ${p.updated.join("、")}` : ""}`;
    case "subtask_dispatched": return `派发「${p.subtask_key}」给 ${p.agent}${p.attempt > 1 ? `（第 ${p.attempt} 次）` : ""}`;
    case "subtask_reported": return `「${p.subtask_key}」${p.status === "completed" ? "提交了结果" : p.status === "cancelled" ? "被中断" : "执行失败"}`;
    case "subtask_approved": return `通过「${p.subtask_key}」${p.feedback ? `：${p.feedback}` : ""}`;
    case "subtask_rework": return `退回「${p.subtask_key}」：${p.feedback}`;
    case "subtask_stopped": return `停止「${p.subtask_key}」：${p.reason}`;
    case "subtask_dispatch_failed": return `「${p.subtask_key}」未能启动：${p.reason}`;
    case "user_inject": return `留言：${p.text}`;
    case "task_paused": return "暂停了任务";
    case "task_resumed": return "恢复了任务";
    case "task_stopped": return p.by === "user" ? "停止了任务" : `结束任务（未完成）：${p.summary ?? ""}`;
    case "task_completed": return "任务完成";
    case "task_blocked": return `任务受阻：${p.reason}`;
    case "task_abandoned": return "放弃了草稿";
    case "deliverable_updated": return "更新了交付物";
    default: return e.type;
  }
}

export function TaskPage() {
  const { id = "" } = useParams();
  const task = useLoad<any>(`/v1/tasks/${id}`);
  const [events, setEvents] = useState<any[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const action = useAction();

  // Any timeline event means the plan or status may have moved: refetch the task.
  useEffect(() => {
    setEvents([]);
    return stream(`/v1/tasks/${id}/events/stream`, 0, (e) => {
      setEvents((prev) => (prev.some((x) => x.seq === e.seq) ? prev : [...prev, e]));
      void task.reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const t = task.data;
  const sessionId = viewing ?? t?.lead_session_id ?? null;
  if (task.error) return <Page title="任务"><ErrorLine>{task.error}</ErrorLine></Page>;
  if (!t) return <Page title="任务"><span className="muted">加载中…</span></Page>;

  const steer = can(t.permission, "control");
  const verb = (v: string, body: unknown = {}) =>
    action.run(async () => {
      await post(`/v1/tasks/${id}:${v}`, body);
      await task.reload();
    });
  const inject = () => {
    const body = text.trim();
    if (!body) return;
    void action.run(async () => {
      await post(`/v1/tasks/${id}:inject`, { text: body });
      setText("");
    });
  };
  const viewed = t.runs.find((r: any) => r.session_id === sessionId);

  return (
    <div className="split">
      <div className="chat">
        <header className="chat-head">
          <div className="grow">
            <div className="title">{t.title} <Badge tone={TASK_TONE[t.status]}>{TASK_LABEL[t.status] ?? t.status}</Badge></div>
            <div className="muted small">
              <Link to={`/projects/${t.project_id}`}>返回项目</Link> · 正在看：
              {viewed ? (viewed.kind === "lead" ? `lead（${viewed.agent_slug}）` : `成员 ${viewed.agent_slug} ·「${viewed.subtask_key}」`) : "—"}
            </div>
          </div>
          {steer && t.status === "draft" ? (
            <>
              <Btn className="primary" onClick={() => void verb("commit")}>启动</Btn>
              <Btn onClick={() => void verb("abandon")}>放弃</Btn>
            </>
          ) : null}
          {steer && t.status === "active" ? (
            <>
              <Btn onClick={() => void verb("intervene", { action: "pause" })}>暂停</Btn>
              <Btn className="danger" onClick={() => confirm("停止这个任务？正在运行的成员会被中断。") && void verb("intervene", { action: "stop" })}>停止</Btn>
            </>
          ) : null}
          {steer && ["paused", "blocked", "stopped", "completed"].includes(t.status) ? (
            <Btn className="primary" onClick={() => void verb("intervene", { action: "resume" })}>{t.status === "completed" ? "重新打开" : "恢复"}</Btn>
          ) : null}
        </header>
        {sessionId ? (
          <RunView key={sessionId} sessionId={sessionId} />
        ) : (
          <div className="chat-body"><div className="empty">草稿任务还没有 lead 会话。启动后在这里看它工作。</div></div>
        )}
        <footer className="chat-foot">
          <ErrorLine>{action.error}</ErrorLine>
          {t.result ? (
            <div className="card small">
              <strong>交付：</strong>{t.result.summary}
              {t.result.artifacts?.length ? <div className="mono">{t.result.artifacts.join("  ")}</div> : null}
            </div>
          ) : null}
          {steer && t.status === "active" ? (
            <div className="row">
              <input className="grow" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && inject()} placeholder="给 lead 留言（它会在下一个回合读到）" />
              <Btn className="primary" disabled={action.busy || !text.trim()} onClick={inject}>发送</Btn>
            </div>
          ) : null}
        </footer>
      </div>
      <aside>
        <section>
          <h3>计划{t.plan.length ? ` · ${t.counts.done ?? 0}/${t.plan.length}` : ""}</h3>
          {t.plan.length === 0 ? <div className="muted small">lead 还没有制定计划。</div> : null}
          <div className="stack">
            {t.plan.map((n: any) => (
              <div key={n.key} className={`node ${n.status}`}>
                <div className="row">
                  <span className="title grow">{n.label}</span>
                  <Badge tone={NODE_TONE[n.internal_status]}>{NODE_LABEL[n.internal_status]}</Badge>
                </div>
                <div className="muted small">
                  {n.agent || "未指定成员"}
                  {n.depends_on.length ? ` · 依赖 ${n.depends_on.join("、")}` : ""}
                  {n.attempts > 1 ? ` · 第 ${n.attempts} 次尝试` : ""}
                </div>
                {n.goal ? <div className="small">{n.goal}</div> : null}
                {n.review_criteria ? <div className="muted small">验收：{n.review_criteria}</div> : null}
                {n.review_feedback ? <div className="small">评审：{n.review_feedback}</div> : null}
                {n.latest_run_session_id ? (
                  <Btn className="ghost small" style={{ justifySelf: "start", padding: 0 }} onClick={() => setViewing(n.latest_run_session_id)}>查看成员的工作 →</Btn>
                ) : null}
              </div>
            ))}
          </div>
          {viewing ? <Btn className="ghost small" onClick={() => setViewing(null)}>← 回到 lead</Btn> : null}
        </section>
        <section>
          <h3>时间线</h3>
          <div className="timeline">
            {events.map((e) => (
              <div className="ev" key={e.seq}>
                <span className="muted">{new Date(e.created_at).toLocaleTimeString()}</span>
                <span><span className="muted">{e.actor} </span>{describe(e)}</span>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

function RunView({ sessionId }: { sessionId: string }) {
  const timeline = useConversation({ sessionId });
  const scroll = useStickToBottom<HTMLDivElement>(timeline.items);
  return (
    <div className="chat-body" ref={scroll.ref} onScroll={scroll.onScroll}>
      {timeline.items.length === 0 ? <div className="muted small">等待开始…</div> : null}
      {timeline.items.map((item) => <ItemView key={item.key} item={item} onDecide={() => undefined} canControl={false} />)}
      <Link className="small" to={`/sessions/${sessionId}`}>在会话页打开（可审批、可中断）</Link>
    </div>
  );
}
