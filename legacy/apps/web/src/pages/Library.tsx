import { useState } from "react";
import { del, get, patch, post } from "../api.ts";
import { ShareDialog } from "../share.tsx";
import { Documents } from "./Documents.tsx";
import { Btn, Badge, Empty, ErrorLine, Field, Modal, Page, PermissionBadge, can, useAction, useLoad } from "../ui.tsx";

type Kind = "providers" | "skills" | "connectors";
const TABS: [Kind, string][] = [["providers", "模型渠道"], ["skills", "技能"], ["connectors", "连接器"]];
const keyOf = (kind: Kind, row: any): string => (kind === "providers" ? row.id : row.slug);

export function LibraryPage() {
  const [kind, setKind] = useState<Kind>("providers");
  const [docs, setDocs] = useState(false);
  const rows = useLoad<{ data: any[] }>(`/v1/${kind}`);
  const [editing, setEditing] = useState<any | null>(null);
  const [sharing, setSharing] = useState<any | null>(null);
  const [history, setHistory] = useState<any | null>(null);
  const action = useAction();
  return (
    <Page title="资源库" actions={docs ? null : <Btn className="primary" onClick={() => setEditing({})}>新建</Btn>}>
      <div className="tabs">
        {TABS.map(([k, l]) => <button key={k} className={!docs && k === kind ? "on" : ""} onClick={() => { setDocs(false); setKind(k); }}>{l}</button>)}
        <button className={docs ? "on" : ""} onClick={() => setDocs(true)}>知识库</button>
      </div>
      {docs ? <Documents projectId={null} editable /> : null}
      <ErrorLine>{rows.error ?? action.error}</ErrorLine>
      <div className="list" hidden={docs}>
        {rows.data?.data.length === 0 ? <Empty>这里还是空的。资源默认私有，共享后同事才能看到和使用。</Empty> : null}
        {rows.data?.data.map((r) => (
          <div className="card item" key={r.id}>
            <div className="grow">
              <div className="title">{r.name} {r.slug ? <span className="muted mono">{r.slug}</span> : null}</div>
              <div className="muted small">
                {kind === "providers" ? `${r.protocol} · ${r.base_url ?? "官方端点"} · 默认模型 ${r.default_model ?? "—"}` : null}
                {kind === "skills" ? `${r.description || "（无描述）"} · v${r.version} · ${r.files.length} 个文件` : null}
                {kind === "connectors" ? `${r.config.transport ?? "http"} · ${r.config.url ?? r.config.command}` : null}
              </div>
            </div>
            {"has_secret" in r ? <Badge tone={r.has_secret ? "ok" : "warn"}>{r.has_secret ? "已配置密钥" : "无密钥"}</Badge> : null}
            <PermissionBadge value={r.permission} />
            {kind === "skills" ? <Btn onClick={() => setHistory(r)}>历史</Btn> : null}
            {can(r.permission, "edit") ? <Btn onClick={() => setEditing(r)}>编辑</Btn> : null}
            {can(r.permission, "admin") ? <Btn onClick={() => setSharing(r)}>共享</Btn> : null}
            {can(r.permission, "admin") ? (
              <Btn className="danger" onClick={() => confirm(`删除「${r.name}」？`) && void action.run(async () => { await del(`/v1/${kind}/${keyOf(kind, r)}`); await rows.reload(); })}>删除</Btn>
            ) : null}
          </div>
        ))}
      </div>
      {history ? <SkillHistory skill={history} onClose={() => setHistory(null)} onRestored={() => { setHistory(null); void rows.reload(); }} /> : null}
      {editing ? <LibraryForm kind={kind} row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void rows.reload(); }} /> : null}
      {sharing ? <ShareDialog base={`/v1/${kind}/${keyOf(kind, sharing)}`} title={sharing.name} onClose={() => { setSharing(null); void rows.reload(); }} /> : null}
    </Page>
  );
}

function LibraryForm({ kind, row, onClose, onSaved }: { kind: Kind; row: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !row.id;
  const [f, setF] = useState<Record<string, string>>((): Record<string, string> => {
    if (kind === "providers") return { name: row.name ?? "", protocol: row.protocol ?? "openai_completion", base_url: row.base_url ?? "", default_model: row.default_model ?? "", api_key: "" };
    if (kind === "skills") return { name: row.name ?? "", description: row.description ?? "", skill_md: row.files?.find((x: any) => x.path === "SKILL.md")?.content ?? "---\nname: \ndescription: \n---\n" };
    return { name: row.name ?? "", description: row.description ?? "", transport: row.config?.transport ?? "http", url: row.config?.url ?? "", command: row.config?.command ?? "", args: (row.config?.args ?? []).join(" "), secret_key: "authorization", secret_value: "" };
  });
  const action = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = () =>
    action.run(async () => {
      let body: Record<string, unknown>;
      if (kind === "providers") {
        body = { name: f["name"], protocol: f["protocol"], base_url: f["base_url"] || null, default_model: f["default_model"] || null, ...(f["api_key"] ? { api_key: f["api_key"] } : {}) };
      } else if (kind === "skills") {
        const others = (row.files ?? []).filter((x: any) => x.path !== "SKILL.md");
        body = { name: f["name"], description: f["description"], files: [{ path: "SKILL.md", content: f["skill_md"] }, ...others] };
      } else {
        const config = f["transport"] === "stdio" ? { transport: "stdio", command: f["command"], args: f["args"]!.split(/\s+/).filter(Boolean) } : { transport: f["transport"], url: f["url"] };
        body = { name: f["name"], description: f["description"], config, ...(f["secret_value"] ? { secrets: { [f["secret_key"]!]: f["secret_value"] } } : {}) };
      }
      if (isNew) await post(`/v1/${kind}`, body);
      else await patch(`/v1/${kind}/${keyOf(kind, row)}`, body);
      onSaved();
    });
  return (
    <Modal title={isNew ? "新建" : `编辑：${row.name}`} onClose={onClose} wide={kind === "skills"}>
      <div className="stack">
        <Field label="名称"><input value={f["name"]} onChange={set("name")} /></Field>
        {kind === "providers" ? (
          <>
            <Field label="协议">
              <select value={f["protocol"]} onChange={set("protocol")}>
                <option value="openai_completion">OpenAI Chat Completions（Valuz Agent）</option><option value="anthropic">Anthropic（Claude Agent）</option><option value="openai_response">OpenAI Responses（Codex）</option>
              </select>
            </Field>
            <Field label="Base URL" hint="官方端点可留空"><input value={f["base_url"]} onChange={set("base_url")} placeholder="https://…/v1" /></Field>
            <Field label="默认模型"><input value={f["default_model"]} onChange={set("default_model")} /></Field>
            <Field label="API Key" hint={isNew ? "加密保存，之后任何接口都不会再返回它" : "留空则保持原有密钥不变"}><input type="password" value={f["api_key"]} onChange={set("api_key")} autoComplete="off" /></Field>
          </>
        ) : null}
        {kind === "skills" ? (
          <>
            <Field label="描述"><input value={f["description"]} onChange={set("description")} /></Field>
            <Field label="SKILL.md" hint="frontmatter 里的 name / description 决定智能体何时调用它"><textarea rows={14} className="mono" value={f["skill_md"]} onChange={set("skill_md")} /></Field>
          </>
        ) : null}
        {kind === "connectors" ? (
          <>
            <Field label="描述"><input value={f["description"]} onChange={set("description")} /></Field>
            <Field label="传输"><select value={f["transport"]} onChange={set("transport")}><option value="http">HTTP</option><option value="sse">SSE</option><option value="stdio">stdio（在执行设备上启动进程）</option></select></Field>
            {f["transport"] === "stdio" ? (
              <div className="row"><div className="grow"><Field label="命令"><input value={f["command"]} onChange={set("command")} /></Field></div><div className="grow"><Field label="参数"><input value={f["args"]} onChange={set("args")} /></Field></div></div>
            ) : (
              <Field label="URL"><input value={f["url"]} onChange={set("url")} placeholder="https://…/mcp" /></Field>
            )}
            <div className="row">
              <div style={{ width: 160 }}><Field label={f["transport"] === "stdio" ? "密钥环境变量名" : "密钥请求头名"}><input value={f["secret_key"]} onChange={set("secret_key")} /></Field></div>
              <div className="grow"><Field label="密钥值" hint={isNew ? "加密保存，不会返回" : "留空则保持不变"}><input type="password" value={f["secret_value"]} onChange={set("secret_value")} autoComplete="off" /></Field></div>
            </div>
          </>
        ) : null}
        <ErrorLine>{action.error}</ErrorLine>
        <div className="row"><Btn className="primary" disabled={action.busy || !f["name"]} onClick={() => void save()}>保存</Btn><Btn onClick={onClose}>取消</Btn></div>
      </div>
    </Modal>
  );
}

function SkillHistory({ skill, onClose, onRestored }: { skill: any; onClose: () => void; onRestored: () => void }) {
  const versions = useLoad<{ current: number; data: any[] }>(`/v1/skills/${skill.slug}/versions`);
  const [viewing, setViewing] = useState<any | null>(null);
  const action = useAction();
  const open = (version: number) => action.run(async () => setViewing(await get(`/v1/skills/${skill.slug}/versions/${version}`)));
  const restore = (version: number) =>
    confirm(`把「${skill.name}」恢复到第 ${version} 版？会生成一个新版本，历史不会丢。`) &&
    void action.run(async () => { await post(`/v1/skills/${skill.slug}/versions/${version}/restore`); onRestored(); });
  return (
    <Modal title={`版本历史：${skill.name}`} onClose={onClose} wide>
      <ErrorLine>{action.error ?? versions.error}</ErrorLine>
      {versions.data?.data.map((v) => (
        <div className="item" key={v.version}>
          <span className="title">第 {v.version} 版</span>
          {v.version === versions.data?.current ? <Badge tone="ok">当前</Badge> : null}
          <span className="grow muted small">{v.created_by_name ?? "—"} · {new Date(v.created_at).toLocaleString()} · {v.file_count} 个文件</span>
          <Btn onClick={() => void open(v.version)}>查看</Btn>
          {can(skill.permission, "edit") && v.version !== versions.data?.current ? <Btn onClick={() => restore(v.version)}>恢复到此版</Btn> : null}
        </div>
      ))}
      {viewing ? <pre className="card mono" style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 320, overflow: "auto" }}>{viewing.files.find((f: any) => f.path === "SKILL.md")?.content}</pre> : null}
    </Modal>
  );
}
