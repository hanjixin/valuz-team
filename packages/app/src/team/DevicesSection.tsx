/** Settings → Devices: the computers linked to the server, and reaching into them. (agent-base addition.) */
import { useEffect, useRef, useState } from "react";
import { type Device, type DeviceFsEntry, authApi, teamApi } from "@valuz/core";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  useI18n,
} from "@valuz/ui";
import { ShareDialog } from "./ShareDialog";
import { ErrorLine, Section, attempt, useLoaded } from "./shared";
import { ThisComputer, onDesktop } from "./ThisComputer";

const RANK = { view: 1, use: 2, edit: 3, control: 4, admin: 5 } as const;

function FileBrowser({ device, onClose }: { device: Device; onClose: () => void }) {
  const { t } = useI18n();
  const start = device.info.shared_roots?.[0] ?? "/";
  const [path, setPath] = useState(start);
  const [typed, setTyped] = useState(start);
  const [entries, setEntries] = useState<DeviceFsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (target: string) => {
    setError(
      await attempt(async () => {
        const listing = await teamApi.listDeviceFolder(device.id, target);
        setPath(listing.path);
        setTyped(listing.path);
        setEntries(listing.entries);
      }),
    );
  };
  const parent = path.replace(/[\\/][^\\/]+[\\/]?$/, "") || "/";

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("team.devices.browseTitle", { name: device.name })}</DialogTitle>
        </DialogHeader>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void open(typed);
          }}
        >
          <Input
            aria-label={t("team.devices.browsePath")}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <Button type="submit">{t("team.devices.browseGo")}</Button>
          <Button type="button" variant="outline" onClick={() => void open(parent)}>
            {t("team.devices.browseUp")}
          </Button>
        </form>
        <ErrorLine message={error} />
        <ul className="flex max-h-80 flex-col overflow-auto text-sm" data-testid="device-files">
          {entries?.map((entry) => (
            <li key={entry.path}>
              {entry.kind === "dir" ? (
                <button
                  type="button"
                  className="w-full rounded px-2 py-1 text-left hover:bg-muted"
                  onClick={() => void open(entry.path)}
                >
                  📁 {entry.name}
                </button>
              ) : (
                <span className="block px-2 py-1 text-muted-foreground">{entry.name}</span>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export function DevicesSection() {
  const { t } = useI18n();
  const me = useLoaded(() => authApi.me());
  const devices = useLoaded(() => teamApi.devices());
  // A computer comes and goes: what is listed is kept current while the page is open.
  const refresh = useRef(devices.reload);
  refresh.current = devices.reload;
  useEffect(() => {
    const timer = setInterval(() => refresh.current(), 5000);
    return () => clearInterval(timer);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<Device | null>(null);
  const [browsing, setBrowsing] = useState<Device | null>(null);

  const server = window.location.origin;
  const email = me.data?.user.email ?? "you@example.com";

  return (
    <div className="flex flex-col gap-4">
      {onDesktop() ? <ThisComputer onChanged={devices.reload} /> : null}
      <Section title={t("team.devices.title")} description={t("team.devices.desc")}>
        <ErrorLine message={error ?? devices.error} />
        {devices.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("team.devices.empty")}</p>
        ) : null}
        {devices.data?.map((device) => {
          const runtimes = (device.info.runtimes ?? []).filter((r) => r.available).map((r) => r.runtime);
          return (
            <div key={device.id} className="flex flex-col gap-2 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium">
                  {device.name}
                  <Badge variant={device.online ? "default" : "secondary"}>
                    {t(device.online ? "team.devices.online" : "team.devices.offline")}
                  </Badge>
                  <Badge variant="outline">{t(`team.permission.${device.permission}`)}</Badge>
                </span>
                <span className="flex gap-1">
                  {RANK[device.permission] >= RANK.control ? (
                    <Button variant="outline" size="sm" disabled={!device.online} onClick={() => setBrowsing(device)}>
                      {t("team.devices.browse")}
                    </Button>
                  ) : null}
                  {device.permission === "admin" ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setSharing(device)}>
                        {t("team.sharing.share")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (!window.confirm(t("team.devices.revokeConfirm", { name: device.name }))) return;
                          void attempt(() => teamApi.revokeDevice(device.id)).then((message) => {
                            setError(message);
                            devices.reload();
                          });
                        }}
                      >
                        {t("team.devices.revoke")}
                      </Button>
                    </>
                  ) : null}
                </span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
                <dt>{t("team.devices.owner")}</dt>
                <dd>{device.owner_name}</dd>
                <dt>{t("team.devices.runtimes")}</dt>
                <dd>{runtimes.join(", ") || "—"}</dd>
                <dt>{t("team.devices.shared")}</dt>
                <dd>{device.info.shared_roots?.join(", ") || t("team.devices.noShared")}</dd>
                <dt>{t("team.devices.exec")}</dt>
                <dd>{t(device.info.allow_exec ? "team.devices.execOn" : "team.devices.execOff")}</dd>
              </dl>
            </div>
          );
        })}
      </Section>

      {/* In a browser there is no computer to link from the page: the member runs the host themselves. */}
      {onDesktop() ? null : (
        <Section title={t("team.devices.link")} description={t("team.devices.linkDesc")}>
          <pre className="overflow-auto rounded-md bg-muted p-3 text-xs" data-testid="link-commands">
            {`agent-base-host login --server ${server} --email ${email}\nagent-base-host run`}
          </pre>
        </Section>
      )}

      {sharing ? (
        <ShareDialog type="device" id={sharing.id} name={sharing.name} onClose={() => setSharing(null)} />
      ) : null}
      {browsing ? <FileBrowser device={browsing} onClose={() => setBrowsing(null)} /> : null}
    </div>
  );
}
