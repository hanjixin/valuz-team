import { app, session } from "electron";
import {
  EgressManager,
  readPersistedEgressMode,
  resolveEgressFrontendsEnabled,
  resolveInitialEgressMode,
} from "@valuz/desktop-network-egress/main";
import { type TeamServiceManager, createTeamServiceManager } from "../services/team";
import { getMainWindow } from "../windows";
import { createDesktopRuntime } from "./services";

type DesktopRuntime = ReturnType<typeof createDesktopRuntime>;

let _desktopRuntime: DesktopRuntime | null = null;
let _teamManager: TeamServiceManager | null = null;

/** The connection to the team's server, for the screens that set it up. */
export const getTeamManager = (): TeamServiceManager => {
  getDesktopRuntime();
  return _teamManager as TeamServiceManager;
};

export const getDesktopRuntime = () => {
  if (!_desktopRuntime) {
    const userDataDir = app.getPath("userData");
    const emergencyOverride =
      process.env.VALUZ_EGRESS_MODE?.trim().toLowerCase() === "off";
    const frontendsEnabled = resolveEgressFrontendsEnabled(
      process.env,
      app.commandLine.hasSwitch("disable-valuz-egress-frontends"),
    );
    const egressManager = new EgressManager({
      mode: resolveInitialEgressMode({
        env: process.env,
        persistedMode: readPersistedEgressMode(userDataDir),
      }),
      env: process.env,
      resolveSystemProxy: (targetUrl) =>
        session.defaultSession.resolveProxy(targetUrl),
      frontendsEnabled,
      emergencyOverride,
    });
    // agent-base: no local backend to own — the manager proxies to the team's
    // server and supervises the host that links this computer to it.
    _teamManager = createTeamServiceManager(userDataDir, {
      egressManager,
      onChange: (services) => getMainWindow()?.webContents.send("service-status-changed", services),
    });
    _desktopRuntime = createDesktopRuntime(
      _teamManager,
      (eventName, payload) => {
        const window = getMainWindow();
        if (
          !window ||
          window.isDestroyed() ||
          window.webContents.isDestroyed()
        ) {
          return;
        }
        window.webContents.send(eventName, payload);
      },
    );
  }
  return _desktopRuntime;
};

/** Convenience alias — safe after app.whenReady(). */
export const desktopRuntime = new Proxy(
  {} as DesktopRuntime,
  {
    get(_target, prop) {
      return Reflect.get(getDesktopRuntime(), prop);
    },
  },
);
