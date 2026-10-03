import { useState } from "react";
import { del, patch, post } from "../api.ts";
import { ShareDialog } from "../share.tsx";
import { Btn, Badge, Empty, ErrorLine, Field, Modal, Page, PermissionBadge, can, useAction, useLoad } from "../ui.tsx";

const RUNTIMES: [string, string, string][] = [
  ["claude_agent", "Claude Agent", "anthropic"], ["codex", "Codex Agent", "openai_response"], ["valuz_agent", "Valuz Agent", "openai_completion"],
];

export function AgentsPage() {
  const agents = useLoad<{ data: any[] }>("/v1/agents");
  const [editing, setEditing] = useState<any | null>(null);
  const [sharing, setSharing] = useState<any | null>(null);
  const action = useAction();
  const [imported, setImported] = useState<any | null>(null);
  /** A pack carries agents with their skills and connectors — never model channels or credentials. */
  const exportPack = () =>
    action.run(async () => {
      const usable = (agents.data?.data ?? []).filter((a) => can(a.permission, "use")).map((a) => a.slug);
      const pack = await post("/v1/agent-packs/export", { agent_slugs: usable });
      const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" }));
      const link = Object.assign(document.createElement("a"), { href: url, download: "agents.pack.json" });
      link.click();
      URL.revokeObjectURL(url);
    });
  const importPack = (e: { target: HTMLInputElement }) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void action.run(async () => {
      let pack: unknown;
      try {
        pack = JSON.parse(await file.text());
      } catch {
        throw new Error("这不是一个有效的 Pack 文件（不是 JSON）。");
      }
      setImported(await post("/v1/agent-packs/import", { pack }));
      await agents.reload();
    });
  };
  return (
    <Page
      title="智能体"
      actions={<>
        <label><input type="file" hidden accept="application/json,.json" onChange={importPack} /><span className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>导入 Pack</span></label>
        <Btn disabled={!agents.data?.data.length} onClick={() => void exportPack()}>导出全部</Btn>
        <Btn className="primary" onClick={() => setEditing({})}>新建智能体</Btn>
      </>}
    >
      {imported ? (
        <div className="card small stack">
          <div>已导入 {imported.created.length} 项{imported.skipped.length ? `，${imported.skipped.length} 项因同名已存在而跳过` : ""}。</div>
          {imported.needs_attention.map((n: string) => <div key={n} className="muted">· {n}</div>)}
        </div>
      ) : null}
      <ErrorLine>{agents.error ?? action.error}</ErrorLine>
      <div className="list">
        {agents.data?.data.length === 0 ? <Empty>还没有智能体。新建一个，或让同事把他的共享给你。</Empty> : null}
        {agents.data?.data.map((a) => (
          <div className="card item" key={a.id}>
            <div className="grow">
              <div className="title">{a.name} <span className="muted mono">{a.slug}</span></div>
              <div className="muted small">{a.description || "（无描述）"}</div>
            </div>
            <Badge>{RUNTIMES.find(([v]) => v === a.runtime)?.[1] ?? a.runtime}</Badge>
            <PermissionBadge value={a.permission} />
            <Btn onClick={() => void action.run(async () => { await post(`/v1/agents/${a.slug}/copy`); await agents.reload(); })}>复制</Btn>
            {can(a.permission, "edit") ? <Btn onClick={() => setEditing(a)}>编辑</Btn> : null}
            {can(a.permission, "admin") ? <Btn onClick={() => setSharing(a)}>共享</Btn> : null}
            {can(a.permission, "admin") ? (
              <Btn className="danger" onClick={() => confirm(`删除智能体「${a.name}」？`) && void action.run(async () => { await del(`/v1/agents/${a.slug}`); await agents.reload(); })}>删除</Btn>
            ) : null}
          </div>
        ))}
      </div>
      {editing ? <AgentForm agent={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void agents.reload(); }} /> : null}
      {sharing ? <ShareDialog base={`/v1/agents/${sharing.slug}`} title={sharing.name} onClose={() => { setSharing(null); void agents.reload(); }} /> : null}
    </Page>
  );
}

function AgentForm({ agent, onClose, onSaved }: { agent: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !agent.id;
  const providers = useLoad<{ data: any[] }>("/v1/providers");
  const skills = useLoad<{ data: any[] }>("/v1/skills");
  const connectors = useLoad<{ data: any[] }>("/v1/connectors");
  const [f, setF] = useState({
    name: agent.name ?? "", description: agent.description ?? "", instructions: agent.instructions ?? "", runtime: agent.runtime ?? "claude_agent",
    model: agent.model ?? "", provider_id: agent.provider_id ?? "", permission_mode: agent.permission_mode ?? "full_access",
    skills: (agent.skills ?? []) as string[], connectors: (agent.connectors ?? []) as string[],
  });
  const action = useAction();
  const protocol = RUNTIMES.find(([v]) => v === f.runtime)?.[2];
  const usable = providers.data?.data.filter((p) => p.protocol === protocol) ?? [];
  const toggle = (key: "skills" | "connectors", slug: string) =>
    setF({ ...f, [key]: f[key].includes(slug) ? f[key].filter((s) => s !== slug) : [...f[key], slug] });
  const save = () =>
    action.run(async () => {
      const body = { ...f, provider_id: f.provider_id || null };
      if (isNew) await post("/v1/agents", body);
      else await patch(`/v1/agents/${agent.slug}`, body);
      onSaved();
    });
  return (
    <Modal title={isNew ? "新建智能体" : `编辑：${agent.name}`} onClose={onClose} wide>
      <div className="stack">
        <div className="row">
          <div className="grow"><Field label="名称"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
          <div className="grow"><Field label="一句话描述" hint="任务的 lead 靠它决定把子任务派给谁"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
        </div>
        <Field label="工作方法（系统提示词）"><textarea rows={6} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
        <div className="row">
          <div className="grow"><Field label="运行时">
            <select value={f.runtime} onChange={(e) => setF({ ...f, runtime: e.target.value, provider_id: "" })}>{RUNTIMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </Field></div>
          <div className="grow"><Field label="模型渠道" hint={f.runtime === "valuz_agent" ? "必选" : "留空则使用执行设备本机的登录态"}>
            <select value={f.provider_id} onChange={(e) => setF({ ...f, provider_id: e.target.value })}>
              <option value="">（不指定）</option>
              {usable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field></div>
          <div className="grow"><Field label="模型" hint="留空用渠道默认模型"><input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field></div>
        </div>
        <Field label="权限模式">
          <select value={f.permission_mode} onChange={(e) => setF({ ...f, permission_mode: e.target.value })}>
            <option value="full_access">完全访问（不询问）</option><option value="auto_review">自动通过文件修改，其余询问</option><option value="default">每次操作都询问</option>
          </select>
        </Field>
        <Field label="技能">
          <div className="row">{skills.data?.data.length ? skills.data.data.map((s) => (
            <label key={s.slug} className="row small"><input style={{ width: "auto" }} type="checkbox" checked={f.skills.includes(s.slug)} onChange={() => toggle("skills", s.slug)} />{s.name}</label>
          )) : <span className="muted small">资源库里还没有技能</span>}</div>
        </Field>
        <Field label="连接器">
          <div className="row">{connectors.data?.data.length ? connectors.data.data.map((c) => (
            <label key={c.slug} className="row small"><input style={{ width: "auto" }} type="checkbox" checked={f.connectors.includes(c.slug)} onChange={() => toggle("connectors", c.slug)} />{c.name}</label>
          )) : <span className="muted small">资源库里还没有连接器</span>}</div>
        </Field>
        <ErrorLine>{action.error}</ErrorLine>
        <div className="row"><Btn className="primary" disabled={action.busy || !f.name} onClick={() => void save()}>保存</Btn><Btn onClick={onClose}>取消</Btn></div>
      </div>
    </Modal>
  );
}
