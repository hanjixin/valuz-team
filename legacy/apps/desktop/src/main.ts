/**
 * Agent Base desktop shell. The window shows the web app served by the team's
 * server; this process supervises the host (`agent-base-host`) that links this
 * computer to that server and runs sessions here. It replaces the Electron +
 * Python-sidecar pairing of valuz-agent.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeImage, shell } from "electron";
import log from "electron-log/main.js";
import type { Channel, DesktopInfo } from "./bridge.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env["AGENT_BASE_DESKTOP_DATA"] ?? app.getPath("userData");
if (process.env["AGENT_BASE_DESKTOP_DATA"]) app.setPath("userData", dataDir);
const hostHome = path.join(dataDir, "host");
const settingsFile = path.join(dataDir, "desktop.json");
const hostConfigFile = path.join(hostHome, "host.json");
/** The host's entry point: next to the app when packaged, in the monorepo otherwise. */
const hostCli = process.env["AGENT_BASE_HOST_CLI"] ?? [path.join(process.resourcesPath ?? "", "host", "cli.js"), path.resolve(here, "../../host/dist/cli.js")].find(existsSync) ?? "";

interface HostConfig {
  server_url: string;
  device_id: string;
  device_token: string;
  owner_user_id: string;
  shared_roots: string[];
  allow_exec: boolean;
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

let serverUrl = readJson<{ server_url: string }>(settingsFile)?.server_url ?? "";
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let host: ChildProcess | null = null;
let hostState: DesktopInfo["host"] = "stopped";
let restartTimer: NodeJS.Timeout | null = null;
let quitting = false;

function info(): DesktopInfo {
  const config = readJson<HostConfig>(hostConfigFile);
  // A link made for another server is not this server's device.
  const linked = config && config.server_url === serverUrl ? config : null;
  return {
    version: app.getVersion(),
    platform: process.platform,
    hostname: hostname(),
    server_url: serverUrl,
    device_id: linked?.device_id ?? null,
    shared_roots: linked?.shared_roots ?? [],
    allow_exec: linked?.allow_exec ?? false,
    host: linked ? hostState : "stopped",
  };
}

const broadcast = (): void => win?.webContents.send("desktop:changed", info());

function setHostState(state: DesktopInfo["host"]): void {
  if (hostState === state) return;
  hostState = state;
  broadcast();
}

async function saveHostConfig(config: HostConfig): Promise<void> {
  await mkdir(hostHome, { recursive: true });
  await writeFile(hostConfigFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(hostConfigFile, 0o600);
}

function stopHost(): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const child = host;
  host = null;
  child?.kill("SIGTERM");
  setHostState("stopped");
}

/** Run the host as a child process and keep it running. */
function startHost(): void {
  stopHost();
  if (!info().device_id) return;
  if (!hostCli) return void log.error("host entry point not found; set AGENT_BASE_HOST_CLI");
  setHostState("starting");
  // The app's own Electron binary doubles as the Node runtime for the host.
  const child = spawn(process.execPath, [hostCli, "run"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENT_BASE_HOME: hostHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host = child;
  const onLine = (line: string): void => {
    log.info(`[host] ${line}`);
    if (child !== host) return;
    if (line.includes("link online")) setHostState("online");
    else if (line.includes("link rejected")) setHostState("rejected");
    else if (line.includes("link offline")) setHostState("offline");
  };
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line.trim());
    });
  }
  child.on("exit", (code) => {
    if (child !== host) return; // replaced or stopped on purpose
    host = null;
    log.warn(`host exited with code ${code}`);
    // A revoked device must not be retried; anything else is.
    if (hostState === "rejected" || quitting) return;
    setHostState("offline");
    restartTimer = setTimeout(startHost, 3000);
  });
}

async function updateHostConfig(change: (config: HostConfig) => void): Promise<DesktopInfo> {
  const config = readJson<HostConfig>(hostConfigFile);
  if (!config || config.server_url !== serverUrl) throw new Error("这台电脑还没有链接为设备");
  change(config);
  await saveHostConfig(config);
  startHost(); // the host reads its sharing policy at start
  return info();
}

const serverOrigin = (): string | null => {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return null;
  }
};

async function connectServer(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "这不是一个有效的地址。";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "地址需要以 http:// 或 https:// 开头。";
  try {
    const res = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(8000) });
    if (!res.ok || ((await res.json()) as { status?: string }).status !== "ok") return "这个地址有响应，但不是可用的 Agent Base 服务器。";
  } catch {
    return "连接不上这个地址，请检查网络和地址是否正确。";
  }
  serverUrl = url.origin;
  await mkdir(dataDir, { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ server_url: serverUrl }));
  await loadApp();
  startHost();
  return null;
}

async function loadApp(): Promise<void> {
  if (!win) return;
  if (serverUrl) await win.loadURL(serverUrl).catch((err: Error) => log.error(`could not load ${serverUrl}: ${err.message}`));
  else await win.loadFile(path.join(here, "setup.html"));
}

/**
 * Privileged calls are accepted only from the server's own pages (or, for the
 * first-run screen, from the bundled setup page) — never from a page the
 * window was navigated to, and never from an embedded frame.
 */
function handle(channel: Channel, fn: (...args: any[]) => unknown, from: "server" | "setup" = "server"): void {
  ipcMain.handle(`desktop:${channel}`, (event, ...args: unknown[]) => {
    const frame = event.senderFrame;
    const url = frame?.url ?? "";
    const trusted = from === "setup" ? url.startsWith("file://") && url.endsWith("/setup.html") : new URL(url).origin === serverOrigin();
    if (!frame || frame.parent !== null || !trusted) throw new Error("not allowed from this page");
    return fn(...args);
  });
}

function registerBridge(): void {
  handle("info", () => info());
  handle("connectServer", (url: string) => connectServer(String(url)), "setup");
  handle("linkDevice", async (device: { device_id: string; device_token: string; owner_user_id: string }) => {
    if (![device?.device_id, device?.device_token, device?.owner_user_id].every((v) => typeof v === "string" && v.length > 0)) throw new Error("invalid device credentials");
    // Nothing is shared until the owner picks a folder.
    await saveHostConfig({ server_url: serverUrl, device_id: device.device_id, device_token: device.device_token, owner_user_id: device.owner_user_id, shared_roots: [], allow_exec: false });
    startHost();
    return info();
  });
  handle("unlink", async () => {
    stopHost();
    await rm(hostConfigFile, { force: true });
    return info();
  });
  handle("pickFolder", async () => {
    if (!win) return info();
    const picked = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], title: "选择要共享给团队的文件夹" });
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return info();
    return updateHostConfig((c) => void (c.shared_roots = [...new Set([...c.shared_roots, folder])]));
  });
  handle("addFolder", (folder: string) => {
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("需要一个绝对路径");
    return updateHostConfig((c) => void (c.shared_roots = [...new Set([...c.shared_roots, path.resolve(folder)])]));
  });
  handle("removeFolder", (folder: string) => updateHostConfig((c) => void (c.shared_roots = c.shared_roots.filter((r) => r !== folder))));
  handle("setAllowExec", (allow: boolean) => updateHostConfig((c) => void (c.allow_exec = allow === true)));
  handle("changeServer", async () => {
    stopHost();
    serverUrl = "";
    await rm(settingsFile, { force: true });
    await loadApp();
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: process.env["AGENT_BASE_DESKTOP_HEADLESS"] !== "1",
    title: "Agent Base",
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // The window stays on the server's pages; everything else opens in the browser.
  const external = (url: string): boolean => {
    try {
      const target = new URL(url);
      return target.protocol !== "file:" && target.origin !== serverOrigin();
    } catch {
      return true;
    }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!external(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  // Closing the window keeps the host running in the tray; Quit really quits.
  win.on("close", (event) => {
    if (quitting || process.platform !== "darwin") return;
    event.preventDefault();
    win?.hide();
  });
  win.on("closed", () => (win = null));
  void loadApp();
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("AB");
  tray.setToolTip("Agent Base");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示窗口", click: () => (win ? win.show() : createWindow()) },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });
  app.on("before-quit", () => {
    quitting = true;
    stopHost();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => (win ? win.show() : createWindow()));
  void app.whenReady().then(() => {
    log.initialize();
    registerBridge();
    createWindow();
    if (process.env["AGENT_BASE_DESKTOP_HEADLESS"] !== "1") createTray();
    startHost();
  });
}
