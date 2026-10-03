import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopInfo } from "./bridge.ts";

const call = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(`desktop:${channel}`, ...args);

const bridge: DesktopBridge & { connectServer(url: string): Promise<string | null> } = {
  info: () => call("info"),
  linkDevice: (device) => call("linkDevice", device),
  unlink: () => call("unlink"),
  pickFolder: () => call("pickFolder"),
  addFolder: (path) => call("addFolder", path),
  removeFolder: (path) => call("removeFolder", path),
  setAllowExec: (allow) => call("setAllowExec", allow),
  changeServer: () => call("changeServer"),
  /** First-run screen only: returns an error message, or null once connected. */
  connectServer: (url) => call("connectServer", url),
  onChange: (listener) => {
    const handler = (_e: unknown, info: DesktopInfo) => listener(info);
    ipcRenderer.on("desktop:changed", handler);
    return () => ipcRenderer.removeListener("desktop:changed", handler);
  },
};

contextBridge.exposeInMainWorld("agentBaseDesktop", bridge);
