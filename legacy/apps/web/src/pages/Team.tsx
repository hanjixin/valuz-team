import { useState } from "react";
import { del, patch, post, put } from "../api.ts";
import type { Me } from "../main.tsx";
import { Btn, Badge, ErrorLine, Modal, Page, timeAgo, useAction, useLoad } from "../ui.tsx";

const ROLE: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };

export function TeamPage({ me }: { me: Me }) {
  const admin = me.role === "owner" || me.role === "admin";
  const members = useLoad<{ data: any[] }>("/v1/org/members");
  const teams = useLoad<{ data: any[] }>("/v1/org/teams");
  const invites = useLoad<{ data: any[] }>(admin ? "/v1/org/invites" : null);
  const audit = useLoad<{ data: any[] }>(admin ? "/v1/org/audit-logs?limit=50" : null);
  const [tab, setTab] = useState<"members" | "teams" | "audit">("members");
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState<any | null>(null);
  const [teamName, setTeamName] = useState("");
  const [editingTeam, setEditingTeam] = useState<any | null>(null);
  const action = useAction();
  const run = (fn: () => Promise<unknown>) =>
    action.run(async () => {
      await fn();
      await Promise.all([members.reload(), teams.reload(), invites.reload()]);
    });

  return (
    <Page title="团队">
      <div className="tabs">
        <button className={tab === "members" ? "on" : ""} onClick={() => setTab("members")}>成员</button>
        <button className={tab === "teams" ? "on" : ""} onClick={() => setTab("teams")}>分组</button>
        {admin ? <button className={tab === "audit" ? "on" : ""} onClick={() => { setTab("audit"); void audit.reload(); }}>审计日志</button> : null}
      </div>
      <ErrorLine>{action.error}</ErrorLine>
      {tab === "members" ? (
        <div className="stack">
          {admin ? (
            <div className="card row">
              <input className="grow" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="同事的邮箱" />
              <Btn className="primary" disabled={action.busy || !email} onClick={() => void run(async () => { setInvite(await post("/v1/org/invites", { email })); setEmail(""); })}>邀请</Btn>
            </div>
          ) : null}
          <table>
            <thead><tr><th>姓名</th><th>邮箱</th><th>角色</th><th /></tr></thead>
            <tbody>
              {members.data?.data.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}{m.id === me.user.id ? <span className="muted">（我）</span> : null}</td>
                  <td className="muted">{m.email}</td>
                  <td>
                    {admin && m.id !== me.user.id && (m.role !== "owner" || me.role === "owner") ? (
                      <select style={{ width: 110 }} value={m.role} onChange={(e) => void run(() => patch(`/v1/org/members/${m.id}`, { role: e.target.value }))} aria-label={`${m.name} 的角色`}>
                        {me.role === "owner" ? <option value="owner">所有者</option> : null}
                        <option value="admin">管理员</option>
                        <option value="member">成员</option>
                      </select>
                    ) : <Badge>{ROLE[m.role]}</Badge>}
                  </td>
                  <td>
                    {admin && m.id !== me.user.id ? (
                      <Btn className="ghost danger" onClick={() => confirm(`移除 ${m.name}？他的共享授权和设备会一并失效。`) && void run(() => del(`/v1/org/members/${m.id}`))}>移除</Btn>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {invites.data?.data.length ? (
            <div className="stack">
              <h3>待接受的邀请</h3>
              {invites.data.data.map((i) => (
                <div className="item" key={i.id}>
                  <span className="grow">{i.email} <span className="muted small">{ROLE[i.role]}</span></span>
                  <Btn className="ghost danger" onClick={() => void run(() => del(`/v1/org/invites/${i.id}`))}>撤销</Btn>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {tab === "teams" ? (
        <div className="stack">
          {admin ? (
            <div className="card row">
              <input className="grow" value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="分组名称，例如「研究组」" />
              <Btn className="primary" disabled={!teamName} onClick={() => void run(async () => { await post("/v1/org/teams", { name: teamName }); setTeamName(""); })}>新建分组</Btn>
            </div>
          ) : null}
          {teams.data?.data.length === 0 ? <div className="muted small">还没有分组。分组用来一次把资源共享给一批人。</div> : null}
          {teams.data?.data.map((t) => (
            <div className="card item" key={t.id}>
              <div className="grow">
                <span className="title">{t.name}</span>{" "}
                <span className="muted small">{t.member_ids.map((id: string) => members.data?.data.find((m) => m.id === id)?.name).filter(Boolean).join("、") || "暂无成员"}</span>
              </div>
              {admin ? <Btn onClick={() => setEditingTeam({ ...t })}>成员</Btn> : null}
              {admin ? <Btn className="danger" onClick={() => confirm(`删除分组「${t.name}」？给它的共享会一并撤销。`) && void run(() => del(`/v1/org/teams/${t.id}`))}>删除</Btn> : null}
            </div>
          ))}
        </div>
      ) : null}
      {tab === "audit" ? (
        <table>
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>详情</th></tr></thead>
          <tbody>
            {audit.data?.data.map((a) => (
              <tr key={a.id}>
                <td className="muted small">{timeAgo(a.created_at)}</td>
                <td>{a.actor_name}</td>
                <td className="mono">{a.action}</td>
                <td className="mono muted" style={{ wordBreak: "break-all" }}>{JSON.stringify(a.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {invite ? (
        <Modal title="邀请已创建" onClose={() => setInvite(null)}>
          <div>把这个链接发给 {invite.email}（只显示这一次，7 天内有效，仅限该邮箱使用）：</div>
          <input readOnly className="mono" value={`${window.location.origin}/#/?invite=${invite.token}`} onFocus={(e) => e.target.select()} />
        </Modal>
      ) : null}
      {editingTeam ? (
        <Modal title={`分组成员：${editingTeam.name}`} onClose={() => setEditingTeam(null)}>
          {members.data?.data.map((m) => (
            <label className="row" key={m.id}>
              <input
                style={{ width: "auto" }}
                type="checkbox"
                checked={editingTeam.member_ids.includes(m.id)}
                onChange={() =>
                  setEditingTeam({
                    ...editingTeam,
                    member_ids: editingTeam.member_ids.includes(m.id) ? editingTeam.member_ids.filter((x: string) => x !== m.id) : [...editingTeam.member_ids, m.id],
                  })
                }
              />
              {m.name} <span className="muted small">{m.email}</span>
            </label>
          ))}
          <Btn className="primary" onClick={() => void run(async () => { await put(`/v1/org/teams/${editingTeam.id}/members`, { user_ids: editingTeam.member_ids }); setEditingTeam(null); })}>保存</Btn>
        </Modal>
      ) : null}
    </Page>
  );
}
