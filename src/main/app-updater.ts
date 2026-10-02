import { app, BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { AppUpdateCheck } from '../shared/protocol'

export type { AppUpdateCheck } from '../shared/protocol'

let downloadedVersion: string | null = null

export interface AppUpdateEvents {
  onLog: (line: string) => void
}

/** Wire updater events once. Safe to call outside packaged builds. */
export function initAppUpdater(events: AppUpdateEvents): void {
  autoUpdater.logger = null // errors surface through events
  autoUpdater.on('error', (error: Error) => {
    events.onLog(`app update error: ${error.message}`)
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    downloadedVersion = info.version
    events.onLog(`app update ${info.version} downloaded and ready to install`)
  })
}

export async function checkForAppUpdate(): Promise<AppUpdateCheck> {
  const current = app.getVersion()
  if (!app.isPackaged) {
    return {
      ok: false,
      current,
      available: false,
      version: null,
      notes: null,
      downloaded: false,
      reason: 'updates apply to installed builds only',
    }
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    const info = result?.updateInfo
    if (!info) {
      return {
        ok: false,
        current,
        available: false,
        version: null,
        notes: null,
        downloaded: false,
        reason: 'no update information returned',
      }
    }
    const available = info.version !== current
    downloadedVersion = available ? info.version : null
    return {
      ok: true,
      current,
      available,
      version: available ? info.version : null,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
      downloaded: available && downloadedVersion === info.version,
      reason: null,
    }
  } catch (cause) {
    return {
      ok: false,
      current,
      available: false,
      version: null,
      notes: null,
      downloaded: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/** Download (if needed) then quit and install. Returns false when unavailable. */
export async function installAppUpdate(): Promise<boolean> {
  if (!app.isPackaged) return false
  try {
    if (!downloadedVersion) {
      await autoUpdater.downloadUpdate()
    }
  } catch (cause) {
    void BrowserWindow.getAllWindows()[0]?.webContents.send(
      'bridge:log',
      `app update download failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return false
  }
  // Give the renderer a beat to acknowledge before the process restarts.
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 400)
  return true
}

export function downloadedUpdateVersion(): string | null {
  return downloadedVersion
}
