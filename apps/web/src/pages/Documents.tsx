import { type ChangeEvent, useEffect, useState } from "react";
import { del, get, post } from "../api.ts";
import { Badge, Btn, ErrorLine, Modal, timeAgo, useAction, useLoad } from "../ui.tsx";

const STATUS: Record<string, [string, "ok" | "warn" | "bad" | "info" | "muted"]> = {
  queued: ["排队中", "muted"], parsing: ["解析中", "info"], ready: ["可检索", "ok"], failed: ["解析失败", "bad"],
};
const ACCEPT = ".md,.markdown,.txt,.csv,.tsv,.json,.yaml,.yml,.html,.htm,.xml,.log,.pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods";

/** A knowledge base: one project's documents, or (projectId = null) the organization library. */
export function Documents({ projectId, editable }: { projectId: string | null; editable: boolean }) {
  const list = useLoad<{ data: any[] }>(`/v1/documents${projectId ? `?project_id=${projectId}` : ""}`);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<any[] | null>(null);
  const [viewing, setViewing] = useState<any | null>(null);
  const action = useAction();
  const docs = (list.data?.data ?? []).filter((d) => (projectId ? d.project_id === projectId : d.project_id === null));
  const pending = docs.some((d) => d.status === "queued" || d.status === "parsing");

  // Parsing happens in the background: keep the list fresh until it settles.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void list.reload(), 1500);
    return () => clearInterval(timer);
  }, [pending, list.reload]);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    void action.run(async () => {
      for (const file of files) {
        const created = await post("/v1/files", { name: file.name, content_type: file.type || "application/octet-stream" });
        const res = await fetch(created.upload.url, { method: "PUT", headers: created.upload.headers, body: file });
        if (!res.ok) throw new Error(`上传失败（存储返回 ${res.status}）`);
        await post(`/v1/files/${created.file.id}/complete`);
        await post("/v1/documents", { file_id: created.file.id, project_id: projectId });
      }
      await list.reload();
    });
  };
  const search = () => action.run(async () => setHits(query.trim() ? (await get(`/v1/documents/search?q=${encodeURIComponent(query)}${projectId ? `&project_id=${projectId}` : ""}`)).data : null));
  const act = (fn: () => Promise<unknown>) => action.run(async () => { await fn(); await list.reload(); });

  return (
    <section className="stack">
      <div className="row">
        <h3 className="grow">{projectId ? "知识库" : "组织知识库"}</h3>
        {editable ? (
          <label>
            <input type="file" hidden multiple accept={ACCEPT} onChange={onFile} />
            <span className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>{action.busy ? "处理中…" : "＋ 添加文档"}</span>
          </label>
        ) : null}
      </div>
      <ErrorLine>{action.error ?? list.error}</ErrorLine>
      {docs.length === 0 ? <div className="muted small">{projectId ? "还没有文档。添加后，这个项目里的智能体在工作时会自动检索它们。" : "还没有文档。组织知识库对所有成员和所有会话可见。"}</div> : null}
      {docs.length > 0 ? (
        <div className="row">
          <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void search()} placeholder="试着搜一下，看智能体能检索到什么" />
          <Btn onClick={() => void search()}>搜索</Btn>
        </div>
      ) : null}
      {hits ? (
        <div className="card stack">
          {hits.length === 0 ? <div className="muted small">没有匹配的段落。</div> : null}
          {hits.map((h, i) => (
            <div key={i} className="small"><span className="title">{h.title}</span><div className="muted" style={{ whiteSpace: "pre-wrap" }}>{h.snippet.slice(0, 360)}{h.snippet.length > 360 ? "…" : ""}</div></div>
          ))}
        </div>
      ) : null}
      {docs.map((d) => {
        const [label, tone] = STATUS[d.status] ?? [d.status, "muted"];
        return (
          <div className="card item" key={d.id}>
            <div className="grow">
              <div className="title">{d.title} <span className="muted mono">{d.filename}</span></div>
              <div className="muted small">{d.status === "failed" ? d.error : `${d.text_chars.toLocaleString()} 字 · ${d.owner_name} · ${timeAgo(d.created_at)}`}</div>
            </div>
            <Badge tone={tone}>{label}</Badge>
            {d.status === "ready" ? <Btn onClick={() => void action.run(async () => setViewing(await get(`/v1/documents/${d.id}`)))}>查看</Btn> : null}
            {editable && d.status === "failed" ? <Btn onClick={() => void act(() => post(`/v1/documents/${d.id}/reindex`))}>重试</Btn> : null}
            {editable ? <Btn className="ghost danger" onClick={() => confirm(`从知识库移除「${d.title}」？`) && void act(() => del(`/v1/documents/${d.id}`))}>移除</Btn> : null}
          </div>
        );
      })}
      {viewing ? (
        <Modal title={viewing.title} onClose={() => setViewing(null)} wide>
          <div className="muted small">解析出的文本（智能体检索和阅读的就是它）{viewing.preview.next_offset ? ` · 仅显示前 ${viewing.preview.text.length.toLocaleString()} 字，共 ${viewing.preview.total_chars.toLocaleString()} 字` : ""}</div>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{viewing.preview.text}</pre>
        </Modal>
      ) : null}
    </section>
  );
}
