import { useEffect } from "react";
import { DESKTOP_EVENTS } from "../../preload/channels";
import { useUpdaterStore } from "@valuz/core";

type DesktopBridge = {
  invoke: <T>(ch: string, args?: unknown) => Promise<T>;
  on: (event: string, handler: (payload: unknown) => void) => void;
  off: (event: string, handler: (payload: unknown) => void) => void;
};

const getBridge = (): DesktopBridge | null =>
  (window as Window & { valuzDesktop?: DesktopBridge }).valuzDesktop ?? null;

interface AvailableInfo {
  version?: string;
}

interface ProgressInfo {
  percent?: number;
  bytesPerSecond?: number;
}

interface DownloadedInfo {
  version?: string;
}

interface ErrorInfo {
  message?: string;
  /** True when the failed operation was a manual check or a download. Errors
   *  from background auto checks arrive with this false and are swallowed. */
  userInitiated?: boolean;
  /** True when the error should also pop the toast (menu/tray check, download);
   *  false for the About-page check, which shows its own inline error. */
  toast?: boolean;
}

interface CheckingInfo {
  userInitiated?: boolean;
}

/**
 * Mounted once at the renderer root. Listens to the main process's
 * autoUpdater lifecycle events and populates the updater Zustand store
 * so the UI (UpdateButton) can react.
 */
export const UpdaterListener = () => {
  const store = useUpdaterStore;

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;

    const onChecking = (payload: unknown) => {
      const info = (payload ?? {}) as CheckingInfo;
      // Only show the "Checking…" state for a manual check — background auto
      // checks run silently.
      if (info.userInitiated) store.getState().setChecking();
    };

    const onAvailable = (payload: unknown) => {
      const info = (payload ?? {}) as AvailableInfo;
      store.getState().setAvailable(info.version ?? "unknown");
    };

    const onNotAvailable = () => {
      store.getState().setNotAvailable();
    };

    const onProgress = (payload: unknown) => {
      const info = (payload ?? {}) as ProgressInfo;
      store.getState().setProgress(
        info.percent ?? 0,
        info.bytesPerSecond ?? 0,
      );
    };

    const onDownloaded = (payload: unknown) => {
      const info = (payload ?? {}) as DownloadedInfo;
      const s = store.getState();
      s.setDownloaded();
      if (info.version && !s.version) {
        store.setState({ version: info.version });
      }
    };

    const onError = (payload: unknown) => {
      const info = (payload ?? {}) as ErrorInfo;
      // Swallow errors from background auto checks — never pop the toast or
      // flag a failure for a check the user didn't ask for. Only surface
      // errors from a manual check or a download. ``toast`` then decides
      // whether the error pops the floating toast (menu/tray/download) or
      // stays inline on the About page.
      if (!info.userInitiated) return;
      store.getState().setError(info.message ?? "Unknown error", info.toast);
    };

    bridge.on(DESKTOP_EVENTS.updaterChecking, onChecking);
    bridge.on(DESKTOP_EVENTS.updaterAvailable, onAvailable);
    bridge.on(DESKTOP_EVENTS.updaterNotAvailable, onNotAvailable);
    bridge.on(DESKTOP_EVENTS.updaterProgress, onProgress);
    bridge.on(DESKTOP_EVENTS.updaterDownloaded, onDownloaded);
    bridge.on(DESKTOP_EVENTS.updaterError, onError);

    return () => {
      bridge.off(DESKTOP_EVENTS.updaterChecking, onChecking);
      bridge.off(DESKTOP_EVENTS.updaterAvailable, onAvailable);
      bridge.off(DESKTOP_EVENTS.updaterNotAvailable, onNotAvailable);
      bridge.off(DESKTOP_EVENTS.updaterProgress, onProgress);
      bridge.off(DESKTOP_EVENTS.updaterDownloaded, onDownloaded);
      bridge.off(DESKTOP_EVENTS.updaterError, onError);
    };
  }, [store]);

  return null;
};
