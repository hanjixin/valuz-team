/** The notification bell: unread count, a list, and a toast when something new arrives. */
import { Popover, PopoverContent, PopoverTrigger } from "@valuz/ui";
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { del, post, stream } from "./api.ts";
import { Btn, timeAgo, useLoad } from "./ui.tsx";

export function Notifications() {
  const inbox = useLoad<{ data: any[]; unread: number }>("/v1/notifications");
  const [open, setOpen] = useState(false);
  const nav = useNavigate();

  useEffect(
    () =>
      stream("/v1/notifications/stream", 0, (e) => {
        if (e.type !== "notification") return;
        toast(e["title"], { description: e["body"] || undefined, action: e["link"] ? { label: "查看", onClick: () => nav(e["link"]) } : undefined });
        void inbox.reload();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const openItem = async (n: any) => {
    setOpen(false);
    if (!n.read_at) await post(`/v1/notifications/${n.id}/read`).catch(() => undefined);
    void inbox.reload();
    if (n.link) nav(n.link);
  };
  const unread = inbox.data?.unread ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="row" style={{ cursor: "pointer", padding: "6px 10px" }} aria-label={`通知${unread ? `，${unread} 条未读` : ""}`}>
          <Bell size={15} /> 通知{unread > 0 ? <span className="small" style={{ color: "var(--accent)", fontWeight: 600 }}>{unread}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-96 p-3">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="title grow">通知</span>
          {unread > 0 ? <Btn className="ghost" onClick={() => void post("/v1/notifications/read-all").then(() => inbox.reload())}>全部已读</Btn> : null}
        </div>
        <div className="stack" style={{ maxHeight: 420, overflowY: "auto" }}>
          {inbox.data?.data.length === 0 ? <div className="muted small">没有通知。任务完成或受阻、自动化运行结束、文档解析失败时会出现在这里。</div> : null}
          {inbox.data?.data.map((n) => (
            <div key={n.id} className="row" style={{ alignItems: "flex-start", opacity: n.read_at ? 0.6 : 1 }}>
              <button type="button" className="grow" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => void openItem(n)}>
                <div className="small title">{n.title}</div>
                {n.body ? <div className="small muted" style={{ overflowWrap: "anywhere" }}>{n.body}</div> : null}
                <div className="small muted">{timeAgo(n.created_at)}</div>
              </button>
              <Btn className="ghost" aria-label="删除" onClick={() => void del(`/v1/notifications/${n.id}`).then(() => inbox.reload())}>×</Btn>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
