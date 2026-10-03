import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { del, patch, post } from "../api.ts";
import { ShareDialog } from "../share.tsx";
import { Automations } from "./Automations.tsx";
import { Channels } from "./Channels.tsx";
import { Documents } from "./Documents.tsx";
import { Memory } from "./Memory.tsx";
import { Btn, Badge, Empty, ErrorLine, Field, Modal, Page, PermissionBadge, can, timeAgo, useAction, useLoad } from "../ui.tsx";

export const TASK_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  active: "info", completed: "ok", blocked: "bad", paused: "warn", stopped: "muted", draft: "muted", abandoned: "muted",
};
export const TASK_LABEL: Record<string, string> = {
  active: "进行中", completed: "已完成", blocked: "受阻", paused: "已暂停", stopped: "已停止", draft: "草稿", abandoned: "已放弃",
};

export function ProjectsPage() {
  const projects = useLoad<{ data: any[] }>("/v1/projects");
  const devices = useLoad<{ data: any[] }>("/v1/devices");
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: "", device_id: "", root_path: "" });
  const action = useAction();
  const nav = useNavigate();
  const create = () =>
    action.run(async () => {
      const p = await post("/v1/projects", { name: f.name, device_id: f.device_id || null, root_path: f.root_path || null });
      nav(`/projects/${p.id}`);
    });
  return (
    <Page title="项目" actions={<Btn className="primary" onClick={() => setCreating(true)}>新建项目</Btn>}>
      <ErrorLine>{projects.error}</ErrorLine>
      <div className="list">
        {projects.data?.data.length === 0 ? <Empty>项目是一个智能体团队的工作场所：绑定一台设备上的文件夹，部署智能体，然后开会话或发起任务。</Empty> : null}
        {projects.data?.data.map((p) => (
          <Link className="card item" key={p.id} to={`/projects/${p.id}`} style={{ color: "inherit" }}>
            <div className="grow"><div className="title">{p.name}</div><div className="muted small mono">{p.root_path ?? "未绑定文件夹"}</div></div>
            <PermissionBadge value={p.permission} /><span className="muted small">{timeAgo(p.updated_at)}</span>
          </Link>
        ))}
      </div>
      {creating ? (
        <Modal title="新建项目" onClose={() => setCreating(false)}>
          <Field label="名称"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="执行设备" hint="项目里的会话和任务在这台设备上运行">
            <select value={f.device_id} onChange={(e) => setF({ ...f, device_id: e.target.value })}>
              <option value="">（稍后再选）</option>
              {devices.data?.data.filter((d) => can(d.permission, "use")).map((d) => <option key={d.id} value={d.id}>{d.name}{d.online ? "" : "（离线）"}</option>)}
            </select>
          </Field>
          <Field label="设备上的文件夹（绝对路径）" hint="若设备不是你的，必须在设备所有者共享的目录之内"><input className="mono" value={f.root_path} onChange={(e) => setF({ ...f, root_path: e.target.value })} placeholder="/Users/me/work/project" /></Field>
          <ErrorLine>{action.error}</ErrorLine>
          <Btn className="primary" disabled={action.busy || !f.name} onClick={() => void create()}>创建</Btn>
        </Modal>
      ) : null}
    </Page>
  );
}

export function ProjectPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const project = useLoad<any>(`/v1/projects/${id}`);
  const sessions = useLoad<{ data: any[] }>(`/v1/sessions?project_id=${id}`);
  const tasks = useLoad<{ data: any[] }>(`/v1/projects/${id}/tasks`);
  const agents = useLoad<{ data: any[] }>("/v1/agents");
  const [sharing, setSharing] = useState(false);
  const [dialog, setDialog] = useState<"session" | "task" | "deploy" | null>(null);
  const [pick, setPick] = useState("");
  const [goal, setGoal] = useState("");
  const [instructions, setInstructions] = useState<string | null>(null);
  const action = useAction();
  const p = project.data;
  if (project.error) return <Page title="项目"><ErrorLine>{project.error}</ErrorLine></Page>;
  if (!p) return <Page title="项目"><span className="muted">加载中…</span></Page>;
  const editable = can(p.permission, "edit");
  const team: any[] = p.agents;
  const deployable = agents.data?.data.filter((a) => can(a.permission, "use") && !team.some((t) => t.slug === a.slug)) ?? [];

  const startSession = () => action.run(async () => nav(`/sessions/${(await post("/v1/sessions", { agent_slug: pick, project_id: id })).id}`));
  const startTask = () => action.run(async () => nav(`/tasks/${(await post(`/v1/projects/${id}/tasks`, { goal, ...(pick ? { lead_agent_slug: pick } : {}) })).id}`));
  const deploy = () => action.run(async () => { await post(`/v1/projects/${id}/agents:deploy`, { agent_slugs: [pick] }); setDialog(null); await project.reload(); });
  const open = (d: "session" | "task" | "deploy", first: string) => { action.clear(); setPick(first); setDialog(d); };

  return (
    <Page
      title={<>{p.name} <PermissionBadge value={p.permission} /></>}
      actions={<>
        <Btn className="primary" disabled={team.length === 0} onClick={() => open("task", p.default_lead_agent_slug ?? team[0]?.slug ?? "")}>发起任务</Btn>
        <Btn disabled={team.length === 0} onClick={() => open("session", team[0]?.slug ?? "")}>新会话</Btn>
        {can(p.permission, "admin") ? <Btn onClick={() => setSharing(true)}>共享</Btn> : null}
        {can(p.permission, "admin") ? <Btn className="danger" onClick={() => confirm("删除这个项目？") && void action.run(async () => { await del(`/v1/projects/${id}`); nav("/projects"); })}>删除</Btn> : null}
      </>}
    >
      <div className="stack">
        <div className="muted small mono">{p.root_path ?? "未绑定文件夹"}</div>
        <section className="card stack">
          <div className="row"><h3 className="grow">团队成员</h3>{editable ? <Btn disabled={deployable.length === 0} onClick={() => open("deploy", deployable[0]?.slug ?? "")}>部署智能体</Btn> : null}</div>
          {team.length === 0 ? <div className="muted small">还没有成员。部署至少一个智能体才能开会话或发起任务。</div> : null}
          {team.map((a) => (
            <div className="item" key={a.slug}>
              <div className="grow"><span className="title">{a.name}</span> <span className="muted small">{a.description}</span></div>
              <Badge>{a.runtime}</Badge>
              {editable ? <Btn className="ghost danger" onClick={() => void action.run(async () => { await del(`/v1/projects/${id}/agents/${a.slug}`); await project.reload(); })}>移除</Btn> : null}
            </div>
          ))}
        </section>
        <section className="card stack">
          <div className="row"><h3 className="grow">项目指令</h3>
            {editable && instructions === null ? <Btn onClick={() => setInstructions(p.instructions_md)}>编辑</Btn> : null}
            {instructions !== null ? <Btn className="primary" onClick={() => void action.run(async () => { await patch(`/v1/projects/${id}`, { instructions_md: instructions }); setInstructions(null); await project.reload(); })}>保存</Btn> : null}
          </div>
          {instructions !== null ? <textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} /> : <div className="small" style={{ whiteSpace: "pre-wrap" }}>{p.instructions_md || <span className="muted">（无）每个会话都会带上这里的内容。</span>}</div>}
        </section>
        <ErrorLine>{dialog ? null : action.error}</ErrorLine>
        <section className="stack">
          <h3>任务</h3>
          {tasks.data?.data.length === 0 ? <div className="muted small">还没有任务。</div> : null}
          {tasks.data?.data.map((t) => (
            <Link className="card item" key={t.id} to={`/tasks/${t.id}`} style={{ color: "inherit" }}>
              <div className="grow"><div className="title">{t.title}</div><div className="muted small">lead：{t.lead_agent_slug} · {t.owner_name} · 子任务 {t.done_count}/{t.subtask_count}</div></div>
              <Badge tone={TASK_TONE[t.status]}>{TASK_LABEL[t.status] ?? t.status}</Badge>
            </Link>
          ))}
        </section>
        <Memory projectId={id as string} editable={editable} />
        <Documents projectId={id as string} editable={editable} />
        <Automations projectId={id as string} team={team} editable={editable} />
        {editable ? <Channels projectId={id as string} team={team} /> : null}
        <section className="stack">
          <h3>会话</h3>
          {sessions.data?.data.length === 0 ? <div className="muted small">还没有会话。</div> : null}
          {sessions.data?.data.map((s) => (
            <Link className="card item" key={s.id} to={`/sessions/${s.id}`} style={{ color: "inherit" }}>
              <div className="grow"><span className="title">{s.title || s.agent_name}</span> <span className="muted small">{s.agent_name} · {s.owner_name}</span></div>
              {s.status === "running" ? <Badge tone="info">运行中</Badge> : null}<span className="muted small">{timeAgo(s.updated_at)}</span>
            </Link>
          ))}
        </section>
      </div>
      {dialog ? (
        <Modal title={dialog === "task" ? "发起任务" : dialog === "session" ? "新会话" : "部署智能体"} onClose={() => setDialog(null)}>
          {dialog === "task" ? <Field label="目标" hint="lead 会把它拆成子任务，派给团队成员，逐个评审后收尾"><textarea rows={5} autoFocus value={goal} onChange={(e) => setGoal(e.target.value)} /></Field> : null}
          <Field label={dialog === "task" ? "Lead 智能体" : "智能体"}>
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              {(dialog === "deploy" ? deployable : team).map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
            </select>
          </Field>
          <ErrorLine>{action.error}</ErrorLine>
          <Btn className="primary" disabled={action.busy || !pick || (dialog === "task" && !goal.trim())}
            onClick={() => void (dialog === "task" ? startTask() : dialog === "session" ? startSession() : deploy())}>
            {dialog === "deploy" ? "部署" : "开始"}
          </Btn>
        </Modal>
      ) : null}
      {sharing ? <ShareDialog base={`/v1/projects/${id}`} kind="project" title={p.name} onClose={() => setSharing(false)} /> : null}
    </Page>
  );
}
