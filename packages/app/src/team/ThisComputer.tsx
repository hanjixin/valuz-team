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

const KEPT_UNLINKED = "agent-base.keep-unlinked";
const keptUnlinked = (): boolean => {
  try {
    return localStorage.getItem(KEPT_UNLINKED) === "1";
  } catch {
    return false;
  }
};
const keepUnlinked = (keep: boolean): void => {
  try {
    if (keep) localStorage.setItem(KEPT_UNLINKED, "1");
    else localStorage.removeItem(KEPT_UNLINKED);
  } catch {
    // no storage: the computer is linked again next time, which is the default anyway
  }
};

/**
 * Agents run on the member's own computer, so the desktop app links it as soon
 * as someone is signed in — unless they unlinked it here themselves. A computer
 * is a device in one organization for one member, so the app is told who is
 * signed in and where: it takes up the link that account has in that
 * organization, or makes one. Quiet on failure: Settings → Devices shows the
 * state and offers the button.
 */
export async function enterAccount(accessToken: string, orgId: string, userId: string): Promise<void> {
  const desktop = bridge();
  if (!desktop || !accessToken || !orgId || !userId) return;
  try {
    await desktop.invoke<Connection>("team_use_account", {
      access_token: accessToken,
      org_id: orgId,
      user_id: userId,
      link: !keptUnlinked(),
    });
  } catch {
    // left as it is
  }
}

/** The team server this desktop app is connected to; null in a browser, which is simply at its server's address. */
export async function serverOfThisDesktop(): Promise<string | null> {
  try {
    return (await bridge()?.invoke<Connection>("team_connection"))?.server_url || null;
  } catch {
    return null;
  }
}

/** Nobody is signed in any more: nothing of theirs keeps running on this computer. */
export async function leaveAccount(): Promise<void> {
  try {
    await bridge()?.invoke<Connection>("team_sign_out");
  } catch {
    // nothing to stop
  }
}

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
    // Unlinking here is a decision the app keeps to; linking takes it back.
    keepUnlinked(channel === "team_unlink_device");
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
            onClick={() =>
              void act("team_link_device", {
                access_token: getAuthSession()?.access_token ?? "",
                org_id: getAuthSession()?.org_id ?? "",
              })
            }
          >
            {t("team.devices.linkThis")}
          </Button>
        )}
      </div>
      <ErrorLine message={error} />
    </Section>
  );
}
