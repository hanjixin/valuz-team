/** The surface the web app sees as `window.agentBaseDesktop` when it runs inside the desktop shell. */
export interface DesktopInfo {
  version: string;
  platform: string;
  hostname: string;
  server_url: string;
  /** This computer's device id on the server, or null when it is not linked. */
  device_id: string | null;
  shared_roots: string[];
  allow_exec: boolean;
  /** `stopped` when unlinked; otherwise the host's link to the server. */
  host: "stopped" | "starting" | "online" | "offline" | "rejected";
}

export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  /** Store the credentials of a device registered for this computer and start the host. */
  linkDevice(device: { device_id: string; device_token: string; owner_user_id: string }): Promise<DesktopInfo>;
  unlink(): Promise<DesktopInfo>;
  /** Open the system folder picker and share the chosen folder. */
  pickFolder(): Promise<DesktopInfo>;
  addFolder(path: string): Promise<DesktopInfo>;
  removeFolder(path: string): Promise<DesktopInfo>;
  setAllowExec(allow: boolean): Promise<DesktopInfo>;
  /** Forget the server and return to the first-run screen. */
  changeServer(): Promise<void>;
  onChange(listener: (info: DesktopInfo) => void): () => void;
}

export const CHANNELS = ["info", "linkDevice", "unlink", "pickFolder", "addFolder", "removeFolder", "setAllowExec", "changeServer", "connectServer"] as const;
export type Channel = (typeof CHANNELS)[number];
