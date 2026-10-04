import { app, type BrowserWindow } from 'electron'
import updaterModule from 'electron-updater'
import log from 'electron-log/main'

const { autoUpdater } = updaterModule

interface SetupUpdaterOptions {
  getMainWindow: () => BrowserWindow | null
  getUpdateWindow: () => BrowserWindow | null
}

/** In-memory state shared with the update window renderer. */
let currentVersion: string | null = null
let isDownloaded = false
/** Whether the in-flight check/download was triggered by the user (a manual
 *  "Check for Updates" click, or a download). The renderer only surfaces
 *  ``checking`` / ``error`` for user-initiated operations — background auto
 *  checks fail silently. */
let userInitiated = false
/** Whether a surfaced error should also pop the floating toast. False for the
 *  in-app About check (the About page shows its own inline error, so a toast
 *  would be redundant); true for menu/tray checks and downloads, where the
 *  toast is the only feedback surface. */
let errorToast = false

/** Where a check was triggered from. ``about`` = the in-app About page (inline
 *  error, no toast); ``menu`` = the app menu / tray (toast, no inline surface);
 *  ``auto`` = the periodic background check (silent on failure). */
type CheckTrigger = 'auto' | 'about' | 'menu'

export const setupUpdater = ({ getMainWindow, getUpdateWindow }: SetupUpdaterOptions) => {
  // Route electron-updater's logs to a file (macOS: ~/Library/Logs/Valuz/main.log,
  // Windows: %USERPROFILE%\AppData\Roaming\Valuz\logs\main.log). By default they
  // only go to the console, which a packaged app discards — so a full-download
  // fallback was untraceable. The differential downloader logs "Download block
  // maps …" and "Cannot download differentially, fallback to full download:
  // <reason>" through this logger, so we can now see whether an update actually
  // ran as a delta and, if not, why.
  log.initialize()
  log.transports.file.level = 'info'
  autoUpdater.logger = log

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const customFeedUrl = process.env.VALUZ_UPDATER_URL
  if (customFeedUrl) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: customFeedUrl,
    })
  }

  const sendToRenderer = (event: string, payload?: unknown) => {
    const mainWindow = getMainWindow()
    if (!mainWindow) {
      return
    }

    mainWindow.webContents.send(event, payload)
  }

  const sendToAll = (event: string, payload?: unknown) => {
    sendToRenderer(event, payload)
    const uw = getUpdateWindow()
    if (uw && !uw.isDestroyed()) {
      uw.webContents.send(event, payload)
    }
  }

  autoUpdater.on('checking-for-update', () => {
    sendToRenderer('updater:checking', { userInitiated })
  })

  autoUpdater.on('update-available', (info) => {
    currentVersion = info.version ?? null
    sendToRenderer('updater:available', info)
  })

  autoUpdater.on('update-not-available', (info) => {
    sendToRenderer('updater:not-available', info)
  })

  autoUpdater.on('download-progress', (progress) => {
    sendToAll('updater:progress', progress)
  })

  autoUpdater.on('update-downloaded', (info) => {
    isDownloaded = true
    sendToAll('updater:downloaded', info)
  })

  autoUpdater.on('error', (error) => {
    sendToAll('updater:error', {
      message: error.message,
      userInitiated,
      toast: errorToast,
    })
  })

  const isDev = !app.isPackaged

  const checkForUpdates = async (trigger: CheckTrigger = 'auto') => {
    userInitiated = trigger !== 'auto'
    errorToast = trigger === 'menu'
    if (isDev) {
      sendToRenderer('updater:not-available', { reason: 'development-mode' })
      return
    }

    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // autoUpdater also emits the 'error' event above, which is where the UI
      // decides whether to surface it (manual only). Swallow the rejected
      // promise here so a failed background check never becomes an unhandled
      // rejection.
    }
  }

  const downloadUpdate = async () => {
    // A download is always user-initiated (the user clicked "Download"), so its
    // failures must surface even if the update was discovered by an auto check —
    // and via the toast, since that's where the download lives.
    userInitiated = true
    errorToast = true
    if (isDev) {
      // Pass 1 — simulate the real network download (slower).
      for (let i = 0; i <= 100; i += 2) {
        await new Promise(r => setTimeout(r, 80))
        sendToAll('updater:progress', { percent: i, bytesPerSecond: 2_500_000 })
      }
      // Pass 2 — simulate the macOS Squirrel.Mac loopback hand-off (fast 0→100),
      // which the renderer collapses into a "preparing" state instead of a
      // second download bar.
      for (let i = 0; i <= 100; i += 10) {
        await new Promise(r => setTimeout(r, 25))
        sendToAll('updater:progress', { percent: i, bytesPerSecond: 80_000_000 })
      }
      isDownloaded = true
      sendToAll('updater:downloaded', { version: currentVersion })
      return
    }
    await autoUpdater.downloadUpdate()
  }

  const quitAndInstall = () => {
    autoUpdater.quitAndInstall()
  }

  const getUpdaterState = () => ({
    version: currentVersion,
    status: isDownloaded ? 'downloaded' as const : 'available' as const,
    progress: 0,
    bytesPerSecond: 0,
  })

  return {
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    getUpdaterState,
  }
}

export const scheduleUpdateCheck = async (checkForUpdates: () => Promise<void>) => {
  if (!app.isPackaged) {
    return
  }

  await checkForUpdates()
  setInterval(() => {
    void checkForUpdates()
  }, 30 * 60 * 1000)
}
