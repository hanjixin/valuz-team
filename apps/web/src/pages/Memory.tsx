import { useState } from "react";
import { del, post } from "../api.ts";
import { Badge, Btn, ErrorLine, timeAgo, useAction, useLoad } from "../ui.tsx";

/** What the project's team has learned; every session of the project starts with it. */
export function Memory({ projectId, editable }: { projectId: string; editable: boolean }) {
  const list = useLoad<{ data: any[] }>(`/v1/projects/${projectId}/memory`);
  const [text, setText] = useState("");
  const action = useAction();
  const act = (fn: () => Promise<unknown>) => action.run(async () => { await fn(); await list.reload(); });
  const add = () => text.trim() && void act(async () => { await post(`/v1/projects/${projectId}/memory`, { content: text.trim() }); setText(""); });
  return (
    <section className="card stack">
      <h3>项目记忆</h3>
      <ErrorLine>{action.error ?? list.error}</ErrorLine>
      {list.data?.data.length === 0 ? <div className="muted small">还没有记忆。这里的每一条都会带进本项目的每个会话；智能体在工作中也会自己记下值得长期保留的事实。</div> : null}
      {list.data?.data.map((m) => (
        <div className="row small" key={m.id} style={{ alignItems: "flex-start" }}>
          <span className="grow" style={{ overflowWrap: "anywhere" }}>{m.content}</span>
          <Badge tone={m.source === "agent" ? "info" : "muted"}>{m.source === "agent" ? "智能体记录" : m.author_name}</Badge>
          <span className="muted">{timeAgo(m.created_at)}</span>
          {editable ? <Btn className="ghost" aria-label="删除这条记忆" onClick={() => void act(() => del(`/v1/projects/${projectId}/memory/${m.id}`))}>×</Btn> : null}
        </div>
      ))}
      {editable ? (
        <div className="row">
          <input className="grow" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()} placeholder="记下一条事实，例如「客户要求所有金额用人民币」" />
          <Btn disabled={action.busy || !text.trim()} onClick={add}>记下</Btn>
        </div>
      ) : null}
    </section>
  );
}
