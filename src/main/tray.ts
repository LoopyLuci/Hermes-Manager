import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

let tray: Tray | null = null
let quitting = false

export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}

function trayImage(): Electron.NativeImage {
  const candidates = [
    join(process.resourcesPath, 'build', 'icon.png'),
    join(app.getAppPath(), 'build', 'icon.png'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return nativeImage.createFromPath(candidate)
  }
  return nativeImage.createEmpty()
}

/** System tray: show/hide the window, quit explicitly (close hides instead). */
export function createTray(getWindow: () => BrowserWindow | null): Tray {
  const image = trayImage()
  tray = new Tray(image)
  tray.setToolTip('Hermes Manager')

  const rebuildMenu = (visible: boolean): void => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: visible ? 'Hide window' : 'Show window',
          click: () => toggleWindow(getWindow),
        },
        { type: 'separator' },
        { label: 'Quit Hermes Manager', click: () => app.quit() },
      ]),
    )
  }

  rebuildMenu(true)
  tray.on('click', () => toggleWindow(getWindow))
  tray.on('double-click', () => toggleWindow(getWindow))
  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

function toggleWindow(getWindow: () => BrowserWindow | null): void {
  const window = getWindow()
  if (!window || window.isDestroyed()) return
  if (window.isVisible()) {
    window.hide()
  } else {
    window.show()
    window.focus()
  }
}
