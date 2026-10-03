import { useState } from "react";
import { del, patch, post } from "../api.ts";
import { Badge, Btn, ErrorLine, Field, Modal, useAction, useLoad } from "../ui.tsx";

/** Feishu bots bound to this project's agents. Only people who can edit the project see this. */
export function Channels({ projectId, team }: { projectId: string; team: { slug: string; name: string }[] }) {
  const list = useLoad<{ data: any[] }>(`/v1/projects/${projectId}/channels`);
  const [creating, setCreating] = useState(false);
  const [tested, setTested] = useState<Record<string, string>>({});
  const [f, setF] = useState({ name: "", agent_slug: team[0]?.slug ?? "", mode: "websocket", app_id: "", app_secret: "", verification_token: "", encrypt_key: "", api_base: "" });
  const action = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const act = (fn: () => Promise<unknown>) => action.run(async () => { await fn(); await list.reload(); });
  const create = () => act(async () => { await post("/v1/channels", { ...f, project_id: projectId }); setCreating(false); });
  const test = (id: string) =>
    action.run(async () => {
      setTested((t) => ({ ...t, [id]: "…" }));
      try {
        await post(`/v1/channels/${id}/test`);
        setTested((t) => ({ ...t, [id]: "ok" }));
      } catch (e) {
        setTested((t) => ({ ...t, [id]: (e as Error).message }));
      }
    });

  return (
    <section className="stack">
      <div className="row"><h3 className="grow">飞书渠道</h3><Btn disabled={team.length === 0} onClick={() => { action.clear(); setCreating(true); }}>接入机器人</Btn></div>
      <ErrorLine>{creating ? null : (action.error ?? list.error)}</ErrorLine>
      {list.data?.data.length === 0 ? <div className="muted small">还没有接入。接入后，人们在飞书里私聊机器人或在群里 @ 它，就是在和这个项目的智能体对话。</div> : null}
      {list.data?.data.map((c) => (
        <div className="card stack" key={c.id}>
          <div className="item">
            <div className="grow"><div className="title">{c.name} <span className="muted mono">{c.app_id}</span></div><div className="muted small">智能体：{c.agent_slug} · {c.mode === "websocket" ? "长连接" : "HTTP 回调"}</div></div>
            {tested[c.id] ? <Badge tone={tested[c.id] === "ok" ? "ok" : tested[c.id] === "…" ? "muted" : "bad"}>{tested[c.id] === "ok" ? "凭据有效" : tested[c.id] === "…" ? "测试中" : "凭据无效"}</Badge> : null}
            <Badge tone={c.enabled ? "ok" : "muted"}>{c.enabled ? "启用" : "停用"}</Badge>
            <Btn onClick={() => void test(c.id)}>测试凭据</Btn>
            <Btn onClick={() => void act(() => patch(`/v1/channels/${c.id}`, { enabled: !c.enabled }))}>{c.enabled ? "停用" : "启用"}</Btn>
            <Btn className="ghost danger" onClick={() => confirm(`移除渠道「${c.name}」？`) && void act(() => del(`/v1/channels/${c.id}`))}>移除</Btn>
          </div>
          {c.mode === "websocket" ? (
            <div className="small muted">长连接模式：服务器主动连到飞书，不需要公网回调地址。在飞书开放平台的"事件与回调"里把订阅方式选为"使用长连接接收事件"，并订阅"接收消息 im.message.receive_v1"。</div>
          ) : (
            <>
              <div className="small muted">事件订阅的请求地址（填到飞书开放平台，并订阅"接收消息 im.message.receive_v1"）：</div>
              <input readOnly className="mono" value={c.callback_url} onFocus={(e) => e.target.select()} aria-label="回调地址" />
            </>
          )}
          {tested[c.id] && !["ok", "…"].includes(tested[c.id]!) ? <div className="error">{tested[c.id]}</div> : null}
        </div>
      ))}
      {creating ? (
        <Modal title="接入飞书机器人" onClose={() => setCreating(false)} wide>
          <div className="muted small">在飞书开放平台创建企业自建应用并开启机器人能力，把下面几项从"凭证与基础信息"里抄过来。</div>
          <div className="row">
            <div className="grow"><Field label="名称"><input autoFocus value={f.name} onChange={set("name")} placeholder="客服机器人" /></Field></div>
            <div className="grow"><Field label="由哪个智能体回答"><select value={f.agent_slug} onChange={set("agent_slug")}>{team.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}</select></Field></div>
          </div>
          <div className="row">
            <div className="grow"><Field label="App ID"><input className="mono" value={f.app_id} onChange={set("app_id")} placeholder="cli_…" autoComplete="off" /></Field></div>
            <div className="grow"><Field label="App Secret" hint="加密保存，不会再返回"><input type="password" value={f.app_secret} onChange={set("app_secret")} autoComplete="off" /></Field></div>
          </div>
          <Field label="接收事件的方式">
            <select value={f.mode} onChange={set("mode")}>
              <option value="websocket">长连接（推荐，服务器不需要公网地址）</option>
              <option value="webhook">HTTP 回调（飞书调用本服务器的公网地址）</option>
            </select>
          </Field>
          {f.mode === "webhook" ? (
            <>
              <div className="row">
                <div className="grow"><Field label="Verification Token"><input type="password" value={f.verification_token} onChange={set("verification_token")} autoComplete="off" /></Field></div>
                <div className="grow"><Field label="Encrypt Key（推荐）" hint="配置后事件会加密并签名"><input type="password" value={f.encrypt_key} onChange={set("encrypt_key")} autoComplete="off" /></Field></div>
              </div>
              <div className="muted small">Verification Token 和 Encrypt Key 至少填一个，否则无法确认消息确实来自飞书。</div>
            </>
          ) : null}
          <Field label="开放平台地址（可选）" hint="飞书留空；Lark 国际版填 https://open.larksuite.com"><input className="mono" value={f.api_base} onChange={set("api_base")} /></Field>
          <ErrorLine>{action.error}</ErrorLine>
          <Btn className="primary" disabled={action.busy || !f.name || !f.app_id || !f.app_secret || (f.mode === "webhook" && !f.verification_token && !f.encrypt_key)} onClick={() => void create()}>保存</Btn>
        </Modal>
      ) : null}
    </section>
  );
}
