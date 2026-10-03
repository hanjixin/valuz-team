/** Small shared UI pieces and data hooks. */
import { Badge as UiBadge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, EmptyState } from "@valuz/ui";
import { type ComponentProps, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get } from "./api.ts";

export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await get<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => void reload(), [reload]);
  return { data, error, reload, setData };
}

/** Run an action, surfacing its failure to the user instead of swallowing it. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}

export const ErrorLine = ({ children }: { children: ReactNode }) => (children ? <div className="error">{children}</div> : null);

export function Page({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <h1>{title}</h1>
        <div className="row">{actions}</div>
      </header>
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={wide ? "sm:max-w-3xl" : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
        </DialogHeader>
        <div className="stack" style={{ maxHeight: "70vh", overflowY: "auto" }}>{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The design system's Button, addressed by intent: `primary`, `danger`,
 * `ghost`, or the default outline.
 */
export function Btn({ className = "", ...props }: ComponentProps<"button">) {
  const tone = className.split(" ");
  const variant = tone.includes("primary") ? "default" : tone.includes("ghost") ? "ghost" : "outline";
  const rest = tone.filter((c) => !["primary", "ghost", "danger"].includes(c)).join(" ");
  return <Button type="button" size="sm" variant={variant} className={`${tone.includes("danger") ? "text-error-text " : ""}${rest}`} {...props} />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

const BADGE_TONE: Record<string, string> = { ok: "text-success-text", warn: "text-warning-text", bad: "text-error-text", info: "text-info-text", muted: "text-muted-foreground" };
export const Badge = ({ tone = "muted", children }: { tone?: "ok" | "warn" | "bad" | "info" | "muted"; children: ReactNode }) => (
  <UiBadge variant="outline" className={BADGE_TONE[tone]}>{children}</UiBadge>
);

export const Empty = ({ children }: { children: string }) => <EmptyState description={children} />;

const PERMISSION_LABEL: Record<string, string> = { view: "可查看", use: "可使用", edit: "可编辑", control: "可控制", admin: "所有者" };
export const PermissionBadge = ({ value }: { value?: string }) =>
  value ? <Badge tone={value === "admin" ? "info" : "muted"}>{PERMISSION_LABEL[value] ?? value}</Badge> : null;

export const can = (permission: string | undefined, needed: "view" | "use" | "edit" | "control" | "admin"): boolean => {
  const rank = ["view", "use", "edit", "control", "admin"];
  return rank.indexOf(permission ?? "") >= rank.indexOf(needed);
};

export const timeAgo = (value: string | number | null | undefined): string => {
  if (!value) return "—";
  const s = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

/** Keep a scroll container pinned to the bottom while the user has not scrolled up. */
export function useStickToBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  return { ref, onScroll };
}
