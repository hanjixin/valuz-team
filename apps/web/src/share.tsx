/** Share dialog — one component for every shareable resource. */
import { useState } from "react";
import { del, put } from "./api.ts";
import { Btn, Badge, ErrorLine, Modal, useAction, useLoad } from "./ui.tsx";

const LEVELS: Record<string, [string, string][]> = {
  default: [["view", "可查看"], ["use", "可使用"], ["edit", "可编辑"]],
  device: [["view", "可查看"], ["use", "可在其上开会话"], ["control", "可远程控制"]],
  session: [["view", "可旁观"], ["control", "可驱动"]],
  project: [["view", "可查看"], ["use", "可开会话与任务"], ["edit", "可编辑并驱动"]],
  file: [["view", "可下载"]],
};

interface Share { id: string; principal_type: string; principal_id: string; principal_name: string; permission: string }

export function ShareDialog({ base, kind = "default", title, onClose }: { base: string; kind?: keyof typeof LEVELS; title: string; onClose: () => void }) {
  const shares = useLoad<{ data: Share[] }>(`${base}/shares`);
  const members = useLoad<{ data: { id: string; name: string; email: string }[] }>("/v1/org/members");
  const teams = useLoad<{ data: { id: string; name: string }[] }>("/v1/org/teams");
  const levels = LEVELS[kind] ?? LEVELS["default"]!;
  const [target, setTarget] = useState("org:");
  const [permission, setPermission] = useState(levels[0]![0]);
  const action = useAction();

  const grant = () =>
    action.run(async () => {
      const [principal_type, principal_id] = target.split(":");
      await put(`${base}/shares`, { principal_type, ...(principal_id ? { principal_id } : {}), permission });
      await shares.reload();
    });
  const revoke = (id: string) => action.run(async () => { await del(`${base}/shares/${id}`); await shares.reload(); });

  return (
    <Modal title={`共享：${title}`} onClose={onClose}>
      <div className="row">
        <select className="grow" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="共享对象">
          <option value="org:">整个组织</option>
          <optgroup label="团队">{teams.data?.data.map((t) => <option key={t.id} value={`team:${t.id}`}>{t.name}</option>)}</optgroup>
          <optgroup label="成员">{members.data?.data.map((m) => <option key={m.id} value={`user:${m.id}`}>{m.name}（{m.email}）</option>)}</optgroup>
        </select>
        <select style={{ width: 150 }} value={permission} onChange={(e) => setPermission(e.target.value)} aria-label="权限">
          {levels.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <Btn className="primary" disabled={action.busy} onClick={() => void grant()}>授权</Btn>
      </div>
      <ErrorLine>{action.error ?? shares.error}</ErrorLine>
      <div className="list">
        {shares.data?.data.length === 0 ? <div className="muted small">尚未共享给任何人——只有你和组织管理员能看到。</div> : null}
        {shares.data?.data.map((s) => (
          <div className="item" key={s.id}>
            <span className="grow">{s.principal_type === "org" ? "整个组织" : s.principal_name}<span className="muted small"> · {s.principal_type === "team" ? "团队" : s.principal_type === "user" ? "成员" : "组织"}</span></span>
            <Badge>{(levels.find(([v]) => v === s.permission) ?? [, s.permission])[1]}</Badge>
            <Btn className="ghost danger" onClick={() => void revoke(s.id)}>撤销</Btn>
          </div>
        ))}
      </div>
    </Modal>
  );
}
