/**
 * Settings → Devices, in the desktop app: this computer's own link to the
 * server. The desktop keeps a host process running once the computer is linked;
 * here the member links it, sees whether it is connected, or unlinks it.
 * (agent-base addition.)
 */
import { useCallback, useEffect, useState } from "react";
import { getAuthSession } from "@valuz/core";
import { Badge, Button, useI18n } from "@valuz/ui";
import { ErrorLine, Section, attempt } from "./shared";

interface Connection {
  server_url: string;
  device_id: string | null;
  device_name: string;
  host: "unlinked" | "starting" | "online" | "offline" | "rejected" | "stopped";
}

type Bridge = { invoke: <T>(channel: string, args?: unknown) => Promise<T> };
const bridge = (): Bridge | null => (window as unknown as { valuzDesktop?: Bridge }).valuzDesktop ?? null;

/** Whether the page runs inside the desktop app, where this computer can be linked. */
export const onDesktop = (): boolean => bridge() !== null;

const LABEL = {
  unlinked: "team.devices.hostUnlinked",
  starting: "team.devices.hostStarting",
  online: "team.devices.hostOnline",
  offline: "team.devices.hostOffline",
  rejected: "team.devices.hostRejected",
  stopped: "team.devices.hostStopped",
} as const;

export function ThisComputer({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const current = await bridge()?.invoke<Connection>("team_connection");
    if (current) setConnection(current);
  }, []);
  // The host connects in the background: follow it while the section is open.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (channel: string, args?: unknown) => {
    setBusy(true);
    setError(
      await attempt(async () => {
        setConnection((await bridge()?.invoke<Connection>(channel, args)) ?? null);
      }),
    );
    setBusy(false);
    onChanged();
  };

  if (!connection) return null;
  const linked = connection.device_id !== null && connection.host !== "rejected";
  return (
    <Section title={t("team.devices.thisComputer")} description={t("team.devices.thisComputerDesc")}>
      <div className="flex items-center justify-between gap-3 rounded-md border p-3" data-testid="this-computer">
        <span className="flex items-center gap-2">
          <span className="font-medium">{connection.device_name}</span>
          <Badge variant={connection.host === "online" ? "default" : "secondary"}>{t(LABEL[connection.host])}</Badge>
        </span>
        {linked ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void act("team_unlink_device")}>
            {t("team.devices.unlinkThis")}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void act("team_link_device", { access_token: getAuthSession()?.access_token ?? "" })}
          >
            {t("team.devices.linkThis")}
          </Button>
        )}
      </div>
      <ErrorLine message={error} />
    </Section>
  );
}
