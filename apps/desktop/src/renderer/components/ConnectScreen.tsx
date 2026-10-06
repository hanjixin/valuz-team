/**
 * agent-base: the first thing a new desktop asks — which team server it
 * belongs to. Everything after (signing in, linking this computer) happens
 * against that server.
 */
import { useState } from "react";
import { Button, Input } from "@valuz/ui";

const zh = (navigator.language || "").toLowerCase().startsWith("zh");
const COPY = zh
  ? {
      title: "连接到团队服务器",
      hint: "输入你们团队的 agent-base 服务器地址。账号、项目和对话都在服务器上；这台电脑链接后作为执行设备，项目文件留在本机。",
      placeholder: "https://agents.example.com",
      connect: "连接",
      connecting: "连接中…",
      back: "返回",
    }
  : {
      title: "Connect to your team's server",
      hint: "Enter the address of your team's agent-base server. Accounts, projects and conversations live there; this computer, once linked, is where agents run — project files stay here.",
      placeholder: "https://agents.example.com",
      connect: "Connect",
      connecting: "Connecting…",
      back: "Back",
    };

export function ConnectScreen({
  onConnect,
  current = "",
  onCancel,
}: {
  onConnect: (url: string) => Promise<void>;
  /** The server it is connected to now, when the question is "which one instead". */
  current?: string;
  /** Present when there is a server to go back to. */
  onCancel?: () => void;
}) {
  const [url, setUrl] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="mx-auto flex h-screen max-w-md flex-col justify-center gap-4 p-8"
      data-testid="connect-screen"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        onConnect(url)
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setBusy(false));
      }}
    >
      <h1 className="text-xl font-semibold">{COPY.title}</h1>
      <p className="text-sm text-muted-foreground">{COPY.hint}</p>
      <Input
        autoFocus
        aria-label={COPY.title}
        placeholder={COPY.placeholder}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={busy || !url.trim()}>
        {busy ? COPY.connecting : COPY.connect}
      </Button>
      {onCancel ? (
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          {COPY.back}
        </Button>
      ) : null}
    </form>
  );
}
