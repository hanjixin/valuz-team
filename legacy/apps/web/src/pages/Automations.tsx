import { useState } from "react";
import { Link } from "react-router-dom";
import { del, patch, post } from "../api.ts";
import { Btn, Badge, ErrorLine, Field, Modal, timeAgo, useAction, useLoad } from "../ui.tsx";

const PRESETS: [string, string][] = [["0 9 * * *", "每天 9:00"], ["0 9 * * 1-5", "工作日 9:00"], ["0 18 * * 5", "每周五 18:00"], ["0 * * * *", "每小时"]];

/** Scheduled automations of one project. */
export function Automations({ projectId, team, editable }: { projectId: string; team: { slug: string; name: string }[]; editable: boolean }) {
  const list = useLoad<{ data: any[] }>(`/v1/projects/${projectId}/automations`);
  const [creating, setCreating] = useState(false);
  const [runsOf, setRunsOf] = useState<any | null>(null);
  const [f, setF] = useState({ name: "", agent_slug: team[0]?.slug ?? "", prompt: "", cron: "0 9 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const action = useAction();
  const act = (fn: () => Promise<unknown>) => action.run(async () => { await fn(); await list.reload(); });
  const create = () => act(async () => { await post(`/v1/projects/${projectId}/automations`, f); setCreating(false); });

  return (
    <section className="stack">
      <div className="row"><h3 className="grow">定时自动化</h3>{editable ? <Btn disabled={team.length === 0} onClick={() => { action.clear(); setCreating(true); }}>新建</Btn> : null}</div>
      <ErrorLine>{creating ? null : (action.error ?? list.error)}</ErrorLine>
      {list.data?.data.length === 0 ? <div className="muted small">还没有定时自动化。让某个智能体按计划自动运行一条指令。</div> : null}
      {list.data?.data.map((a) => (
        <div className="card item" key={a.id}>
          <div className="grow">
            <div className="title">{a.name} <span className="muted mono">{a.cron}</span></div>
            <div className="muted small">{a.agent_slug} · {a.enabled ? `下次 ${a.next_run_at ? new Date(a.next_run_at).toLocaleString() : "—"}` : "已暂停"} · 上次 {timeAgo(a.last_run_at)}</div>
          </div>
          <Badge tone={a.enabled ? "ok" : "muted"}>{a.enabled ? "启用" : "暂停"}</Badge>
          <Btn onClick={() => setRunsOf(a)}>运行记录</Btn>
          {editable ? <Btn onClick={() => void act(() => post(`/v1/automations/${a.id}/run`))}>立即运行</Btn> : null}
          {editable ? <Btn onClick={() => void act(() => patch(`/v1/automations/${a.id}`, { enabled: !a.enabled }))}>{a.enabled ? "暂停" : "启用"}</Btn> : null}
          {editable ? <Btn className="ghost danger" onClick={() => confirm(`删除「${a.name}」？`) && void act(() => del(`/v1/automations/${a.id}`))}>删除</Btn> : null}
        </div>
      ))}
      {creating ? (
        <Modal title="新建定时自动化" onClose={() => setCreating(false)}>
          <Field label="名称"><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="智能体"><select value={f.agent_slug} onChange={(e) => setF({ ...f, agent_slug: e.target.value })}>{team.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}</select></Field>
          <Field label="指令"><textarea rows={4} value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} /></Field>
          <Field label="计划（cron）" hint={`时区：${f.timezone}`}><input className="mono" value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} /></Field>
          <div className="row">{PRESETS.map(([cron, label]) => <Btn key={cron} type="button" className="ghost small" onClick={() => setF({ ...f, cron })}>{label}</Btn>)}</div>
          <ErrorLine>{action.error}</ErrorLine>
          <Btn className="primary" disabled={action.busy || !f.name || !f.prompt.trim() || !f.agent_slug} onClick={() => void create()}>创建</Btn>
        </Modal>
      ) : null}
      {runsOf ? <Runs automation={runsOf} onClose={() => setRunsOf(null)} /> : null}
    </section>
  );
}

function Runs({ automation, onClose }: { automation: any; onClose: () => void }) {
  const runs = useLoad<{ data: any[] }>(`/v1/automations/${automation.id}/runs`);
  return (
    <Modal title={`运行记录：${automation.name}`} onClose={onClose} wide>
      <ErrorLine>{runs.error}</ErrorLine>
      {runs.data?.data.length === 0 ? <div className="muted small">还没有运行过。</div> : null}
      {runs.data?.data.map((r) => (
        <div className="item" key={r.id}>
          <Badge tone={r.status === "completed" ? "ok" : r.status === "failed" ? "bad" : "info"}>{r.status === "completed" ? "完成" : r.status === "failed" ? "失败" : "运行中"}</Badge>
          <span className="grow small">{r.error ?? r.summary ?? ""}</span>
          <span className="muted small">{r.trigger === "manual" ? "手动 · " : ""}{timeAgo(r.started_at)}</span>
          {r.session_id ? <Link className="small" to={`/sessions/${r.session_id}`}>查看会话</Link> : null}
        </div>
      ))}
    </Modal>
  );
}
