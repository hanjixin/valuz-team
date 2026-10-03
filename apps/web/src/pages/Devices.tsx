import { useEffect, useState } from "react";
import { del, post, stream } from "../api.ts";
import { ThisComputer } from "../desktop.tsx";
import type { Me } from "../main.tsx";
import { ShareDialog } from "../share.tsx";
import { Btn, Badge, Empty, ErrorLine, Field, Modal, Page, PermissionBadge, can, timeAgo, useAction, useLoad } from "../ui.tsx";

/** The exact commands to run on the machine being linked. */
function linkCommands(origin: string, created: { id: string; token: string; owner_id: string }): string {
  const config = { server_url: origin, device_id: created.id, device_token: created.token, owner_user_id: created.owner_id, shared_roots: [], allow_exec: false };
  return [
    "mkdir -p ~/.agent-base && cat > ~/.agent-base/host.json <<'JSON'",
    JSON.stringify(config, null, 2),
    "JSON",
    "chmod 600 ~/.agent-base/host.json",
    "agent-base-host share add /绝对路径/要共享的文件夹   # 可选：允许其他成员在此目录工作",
    "agent-base-host run",
  ].join("\n");
}

export function DevicesPage({ me }: { me: Me }) {
  const devices = useLoad<{ data: any[] }>("/v1/devices");
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<any | null>(null);
  const [sharing, setSharing] = useState<any | null>(null);
  const [controlling, setControlling] = useState<any | null>(null);
  const action = useAction();
  // Presence and a device's self-description change on their own: follow the org's live events.
  useEffect(() => stream("/v1/stream", 0, (e) => { if (e.type.startsWith("device.")) void devices.reload(); }), [devices.reload]);
  const register = () => action.run(async () => { setCreated(await post("/v1/devices", { name })); await devices.reload(); });
  const origin = window.location.origin;
  return (
    <Page title="设备" actions={<Btn className="primary" onClick={() => { setCreated(null); setName(""); setRegistering(true); }}>链接新设备</Btn>}>
      <ThisComputer onChanged={() => void devices.reload()} />
      <ErrorLine>{devices.error ?? (registering ? null : action.error)}</ErrorLine>
      <div className="list">
        {devices.data?.data.length === 0 ? <Empty>还没有设备。设备是执行会话的地方——把你的电脑链接上来，或请同事把他的共享给你。</Empty> : null}
        {devices.data?.data.map((d) => (
          <div className="card stack" key={d.id}>
            <div className="item">
              <div className="grow">
                <div className="title">{d.name} <Badge tone={d.online ? "ok" : "muted"}>{d.online ? "在线" : "离线"}</Badge></div>
                <div className="muted small">{d.owner_id === me.user.id ? "我的设备" : `${d.owner_name} 的设备`} · {d.info?.platform ?? "未知系统"} · 最近在线 {timeAgo(d.last_seen_at)}</div>
              </div>
              <PermissionBadge value={d.permission} />
              {can(d.permission, "control") ? <Btn disabled={!d.online} onClick={() => setControlling(d)}>远程控制</Btn> : null}
              {can(d.permission, "admin") ? <Btn onClick={() => setSharing(d)}>共享</Btn> : null}
              {can(d.permission, "admin") ? <Btn className="danger" onClick={() => confirm(`吊销设备「${d.name}」？它的令牌立即失效。`) && void action.run(async () => { await del(`/v1/devices/${d.id}`); await devices.reload(); })}>吊销</Btn> : null}
            </div>
            <div className="small muted">
              共享目录：{d.info?.shared_roots?.length ? <span className="mono">{d.info.shared_roots.join("  ")}</span> : "无（其他成员无法在这台设备上工作）"} · 远程命令：{d.info?.allow_exec ? "已开启" : "关闭"}
            </div>
          </div>
        ))}
      </div>
      {registering ? (
        <Modal title="链接新设备" onClose={() => setRegistering(false)} wide>
          {created ? (
            <div className="stack">
              <div>设备已登记。在那台电脑上运行下面的命令（令牌只显示这一次）：</div>
              <pre className="card mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{linkCommands(origin, created)}</pre>
              <div className="muted small">也可以直接在那台电脑上运行 <span className="mono">agent-base-host login --server {origin} --email {me.user.email}</span>，它会自己登记。</div>
              <Btn onClick={() => setRegistering(false)}>完成</Btn>
            </div>
          ) : (
            <div className="stack">
              <Field label="设备名称"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="我的 MacBook" /></Field>
              <ErrorLine>{action.error}</ErrorLine>
              <Btn className="primary" disabled={action.busy || !name} onClick={() => void register()}>登记</Btn>
            </div>
          )}
        </Modal>
      ) : null}
      {sharing ? <ShareDialog base={`/v1/devices/${sharing.id}`} kind="device" title={sharing.name} onClose={() => { setSharing(null); void devices.reload(); }} /> : null}
      {controlling ? <RemoteControl device={controlling} isOwner={controlling.owner_id === me.user.id} onClose={() => setControlling(null)} /> : null}
    </Page>
  );
}

function RemoteControl({ device, isOwner, onClose }: { device: any; isOwner: boolean; onClose: () => void }) {
  const roots: string[] = device.info?.shared_roots ?? [];
  const [path, setPath] = useState(roots[0] ?? "/");
  const [listing, setListing] = useState<any | null>(null);
  const [file, setFile] = useState<{ path: string; content: string; encoding: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState<any | null>(null);
  const action = useAction();
  const base = `/v1/devices/${device.id}`;

  const list = (target: string) => action.run(async () => { setFile(null); setListing(await post(`${base}/fs/list`, { path: target })); setPath(target); });
  const open = (target: string) => action.run(async () => { const f = await post(`${base}/fs/read`, { path: target }); setFile(f); setDraft(f.content); });
  const save = () => file && action.run(async () => { await post(`${base}/fs/write`, { path: file.path, content: draft }); setFile({ ...file, content: draft }); });
  const run = () => action.run(async () => setOutput(await post(`${base}/exec`, { command, cwd: listing?.path ?? path })));
  const parent = (listing?.path ?? path).replace(/\/[^/]+\/?$/, "") || "/";
  const execAllowed = isOwner || device.info?.allow_exec;

  return (
    <Modal title={`远程控制：${device.name}`} onClose={onClose} wide>
      <div className="muted small">{isOwner ? "这是你的设备，可访问任意路径。" : `只能访问设备所有者共享的目录：${roots.join("、") || "（无）"}`} 所有操作都会记入审计日志。</div>
      <div className="row">
        <input className="grow mono" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void list(path)} aria-label="路径" />
        <Btn onClick={() => void list(path)}>打开</Btn>
      </div>
      <ErrorLine>{action.error}</ErrorLine>
      {file ? (
        <div className="stack">
          <div className="row">
            <span className="mono grow">{file.path}</span>
            <Btn onClick={() => setFile(null)}>返回目录</Btn>
            {file.encoding === "utf8" ? <Btn className="primary" disabled={action.busy || draft === file.content} onClick={() => void save()}>保存</Btn> : null}
          </div>
          {file.encoding === "utf8" ? <textarea className="mono" rows={16} value={draft} onChange={(e) => setDraft(e.target.value)} /> : <div className="muted">二进制文件，无法在此预览。</div>}
        </div>
      ) : listing ? (
        <div className="card files">
          <button onClick={() => void list(parent)}>📁 ..</button>
          {listing.entries.map((e: any) => (
            <button key={e.path} onClick={() => void (e.kind === "dir" ? list(e.path) : open(e.path))}>
              {e.kind === "dir" ? "📁" : "📄"} {e.name}{e.kind === "file" ? <span className="muted">  {e.size} B</span> : null}
            </button>
          ))}
          {listing.entries.length === 0 ? <div className="muted">（空目录）</div> : null}
        </div>
      ) : <div className="muted small">输入路径后点“打开”。</div>}
      <div className="stack">
        <h3>在当前目录执行命令</h3>
        {execAllowed ? (
          <div className="row">
            <input className="grow mono" value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === "Enter" && command && void run()} placeholder="ls -la" />
            <Btn disabled={action.busy || !command} onClick={() => void run()}>执行</Btn>
          </div>
        ) : <div className="muted small">设备所有者没有开启远程命令（在设备上运行 <span className="mono">agent-base-host share exec on</span>）。</div>}
        {output ? <pre className="card mono" style={{ margin: 0, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap" }}>{output.output || "(无输出)"}{`\n[exit ${output.exit_code}${output.timed_out ? "，超时" : ""}]`}</pre> : null}
      </div>
    </Modal>
  );
}
