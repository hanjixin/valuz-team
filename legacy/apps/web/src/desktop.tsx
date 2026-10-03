/** Shown only inside the desktop shell: link this computer as a device and choose what it shares. */
import { useEffect, useState } from "react";
import { del, post } from "./api.ts";
import { Badge, Btn, ErrorLine, useAction } from "./ui.tsx";

interface DesktopInfo {
  version: string;
  platform: string;
  hostname: string;
  server_url: string;
  device_id: string | null;
  shared_roots: string[];
  allow_exec: boolean;
  host: "stopped" | "starting" | "online" | "offline" | "rejected";
}
interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  linkDevice(device: { device_id: string; device_token: string; owner_user_id: string }): Promise<DesktopInfo>;
  unlink(): Promise<DesktopInfo>;
  pickFolder(): Promise<DesktopInfo>;
  addFolder(path: string): Promise<DesktopInfo>;
  removeFolder(path: string): Promise<DesktopInfo>;
  setAllowExec(allow: boolean): Promise<DesktopInfo>;
  changeServer(): Promise<void>;
  onChange(listener: (info: DesktopInfo) => void): () => void;
}
declare global {
  interface Window {
    agentBaseDesktop?: DesktopBridge;
  }
}

const HOST: Record<DesktopInfo["host"], [string, "ok" | "warn" | "bad" | "muted"]> = {
  stopped: ["未运行", "muted"], starting: ["连接中", "warn"], online: ["已连接", "ok"], offline: ["连接断开，重试中", "warn"], rejected: ["设备已被吊销", "bad"],
};

export function ThisComputer({ onChanged }: { onChanged: () => void }) {
  const bridge = window.agentBaseDesktop;
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const action = useAction();
  useEffect(() => {
    if (!bridge) return;
    void bridge.info().then(setInfo);
    return bridge.onChange((next) => {
      setInfo(next);
      onChanged();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!bridge || !info) return null;

  const run = (fn: () => Promise<DesktopInfo | void>) => action.run(async () => { const next = await fn(); if (next) setInfo(next); onChanged(); });
  const link = () =>
    run(async () => {
      const device = await post("/v1/devices", { name: info.hostname });
      return bridge.linkDevice({ device_id: device.id, device_token: device.token, owner_user_id: device.owner_id });
    });
  const unlink = () =>
    confirm("解除后，这台电脑不再执行会话，其他成员也无法再访问它。") &&
    void run(async () => {
      const id = info.device_id;
      const next = await bridge.unlink();
      // Revoke on the server too, so the old token is dead rather than merely forgotten.
      if (id) await del(`/v1/devices/${id}`).catch(() => undefined);
      return next;
    });
  const [label, tone] = HOST[info.host];

  return (
    <section className="card stack">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>这台电脑 · {info.hostname}</h3>
        {info.device_id ? <Badge tone={tone}>{label}</Badge> : null}
        <Btn className="ghost" onClick={() => confirm("更换服务器会断开当前连接。") && void bridge.changeServer()}>更换服务器</Btn>
      </div>
      <ErrorLine>{action.error}</ErrorLine>
      {!info.device_id || info.host === "rejected" ? (
        <>
          <div className="muted small">{info.host === "rejected" ? "这台电脑的设备凭据已失效，需要重新链接。" : "把这台电脑链接为设备后，会话和任务就可以在这里执行。链接后默认不共享任何文件夹。"}</div>
          <div><Btn className="primary" disabled={action.busy} onClick={() => void link()}>把这台电脑链接为设备</Btn></div>
        </>
      ) : (
        <>
          <div className="stack">
            <div className="small muted">共享给团队的文件夹（其他成员只能在这些文件夹里工作；你自己不受限制）：</div>
            {info.shared_roots.length === 0 ? <div className="small">还没有共享任何文件夹。</div> : null}
            {info.shared_roots.map((root) => (
              <div className="row small" key={root}>
                <span className="mono grow" style={{ overflowWrap: "anywhere" }}>{root}</span>
                <Btn className="ghost" onClick={() => void run(() => bridge.removeFolder(root))}>取消共享</Btn>
              </div>
            ))}
          </div>
          <div className="row">
            <Btn disabled={action.busy} onClick={() => void run(() => bridge.pickFolder())}>共享一个文件夹…</Btn>
            <label className="row small">
              <input type="checkbox" checked={info.allow_exec} onChange={(e) => void run(() => bridge.setAllowExec(e.target.checked))} />
              允许有控制权限的成员在这台电脑上远程执行命令
            </label>
            <span className="grow" />
            <Btn className="ghost danger" onClick={unlink}>解除链接</Btn>
          </div>
        </>
      )}
    </section>
  );
}
