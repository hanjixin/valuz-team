import path from "node:path";
import { BrowserWindow, app, dialog } from "electron";

const getUpdateWindowUrl = () => {
  if (process.env.VITE_DEV_SERVER_URL) {
    const base = process.env.VITE_DEV_SERVER_URL.replace(/\/$/, "");
    return `${base}/update.html`;
  }
  return `file://${path.join(app.getAppPath(), "dist", "update.html")}`;
};

const getPreloadPath = () =>
  path.join(app.getAppPath(), "dist-electron", "preload.js");

let updateWindow: BrowserWindow | null = null;

export const getUpdateWindow = () => updateWindow;

export const createUpdateWindow = (version: string) => {
  if (updateWindow) {
    updateWindow.focus();
    return updateWindow;
  }

  const url = getUpdateWindowUrl();

  updateWindow = new BrowserWindow({
    title: `Valuz Update ${version}`,
    width: 400,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 10, y: 10 },
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  updateWindow.once("ready-to-show", () => {
    updateWindow?.show();
  });

  updateWindow.webContents.on("did-fail-load", (_event, code, desc) => {
    console.error(`[update-window] load failed: ${code} ${desc} (url: ${url})`);
    updateWindow?.close();
    dialog.showErrorBox("Update Window Error", `Failed to load: ${code} ${desc}`);
  });

  updateWindow.on("closed", () => {
    updateWindow = null;
  });

  console.log(`[update-window] loading: ${url}`);
  void updateWindow.loadURL(url);

  return updateWindow;
};

export const closeUpdateWindow = () => {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.close();
  }
};
