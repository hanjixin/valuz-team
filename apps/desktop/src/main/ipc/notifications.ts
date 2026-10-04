/**
 * Desktop notification bridge (task attention & reliability).
 *
 * Two IPC handlers the renderer's ``NotificationBridgeProvider`` drives:
 * - ``desktop_notify`` — show a native OS ``Notification``. On click, focus the
 *   main window and forward the carried ``route`` to the renderer as a
 *   ``notification-clicked`` event so it can navigate.
 * - ``desktop_set_badge_count`` — set the dock/taskbar badge (attention count).
 *
 * Notifications are the "强提醒" surface: when the window is hidden/tray-resident
 * an in-app toast is invisible, so an OS notification is the only way an
 * unobserved question or failure reaches the user.
 */

import { app, BrowserWindow, ipcMain, Notification } from "electron";

import { DESKTOP_EVENTS } from "../../preload/channels";
import { getMainWindow } from "../windows";

export interface NotifyPayload {
  title: string;
  body?: string;
  /** In-app route to navigate to on click (e.g. ``/tasks/abc``). */
  route?: string;
  /** Collapses repeat notifications for the same subject (macOS/Windows). */
  tag?: string;
}

function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  win.focus();
}

export function registerNotificationHandlers(): void {
  ipcMain.handle("desktop_notify", async (_event, payload: NotifyPayload) => {
    if (!Notification.isSupported() || !payload?.title) return false;
    const notification = new Notification({
      title: payload.title,
      body: payload.body ?? "",
      silent: false,
    });
    notification.on("click", () => {
      focusMainWindow();
      // Forward the route to whichever main window is alive so the renderer
      // can navigate. ``getMainWindow`` may have been recreated, so resolve
      // fresh and fall back to any window.
      const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0];
      if (win && payload.route) {
        win.webContents.send(DESKTOP_EVENTS.notificationClicked, {
          route: payload.route,
        });
      }
    });
    notification.show();
    return true;
  });

  ipcMain.handle(
    "desktop_set_badge_count",
    async (_event, payload: { count?: number }) => {
      const count = Math.max(0, Math.floor(payload?.count ?? 0));
      // ``app.setBadgeCount`` is macOS + Linux (Unity); on macOS 0 clears the
      // dock badge. Windows has no numeric app badge without an overlay icon,
      // so this is a graceful no-op there.
      try {
        app.setBadgeCount(count);
        return true;
      } catch {
        return false;
      }
    },
  );

  ipcMain.handle("desktop_bounce", async () => {
    // macOS dock icon bounce — "informational" bounces once (until the app is
    // focused). Only fire when the window isn't already focused, so we don't
    // bounce for something the user is looking at. macOS-only; no-op elsewhere.
    try {
      const win = getMainWindow();
      if (win?.isFocused()) return false;
      if (process.platform === "darwin" && app.dock) {
        app.dock.bounce("informational");
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  });
}
