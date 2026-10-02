import { app, BrowserWindow, ipcMain, screen, Notification, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { BridgeSupervisor } from './bridge-supervisor'
import { installSecurityPolicy, openExternal } from './security'
import {
  pickHermesHome,
  readSettings,
  sanitizeSettingsPatch,
  updateSettings,
} from './settings'
import { detectHermesHome } from './hermes-paths'
import { createTray, destroyTray, isQuitting, markQuitting } from './tray'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

let mainWindow: BrowserWindow | null = null
let bridge: BridgeSupervisor | null = null
let rendererCrashCount = 0
let lastBridgeNotifyAt = 0
let bridgeEverFailed = false
let boundsTimer: NodeJS.Timeout | null = null

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body }).show()
}

/** Only our own renderer (dev server or packaged file) may invoke IPC. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? ''
  const devUrl = process.env.ELECTRON_RENDERER_URL ?? ''
  const trusted = isDev ? Boolean(devUrl && url.startsWith(devUrl)) : url.startsWith('file://')
  if (!trusted) {
    throw new Error('untrusted ipc sender')
  }
}

/** Saved bounds are only honoured when they keep the window reachable. */
function usableBounds(): Electron.Rectangle | null {
  const bounds = readSettings().windowBounds
  if (!bounds) return null
  if (bounds.width < 960 || bounds.height < 640) return null
  const area = screen.getDisplayMatching(bounds).workArea
  const overlapX =
    Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  const overlapY =
    Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
  if (overlapX < 100 || overlapY < 50) return null
  return bounds
}

function persistBounds(window: BrowserWindow): void {
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(() => {
    boundsTimer = null
    if (!window || window.isDestroyed() || window.isMinimized() || !window.isVisible()) return
    const bounds = window.getBounds()
    updateSettings({ windowBounds: bounds })
  }, 600)
}

function createWindow(): void {
  const saved = usableBounds()
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 920,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'Hermes Manager',
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build', 'icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url)
    return { action: 'deny' }
  })

  // Closing hides to the tray; only quitting (tray menu / before-quit) closes.
  // E2E runs disable the tray behaviour so Playwright teardown always exits.
  mainWindow.on('close', (event) => {
    if (isQuitting() || !mainWindow || process.env.HM_E2E === '1') return
    event.preventDefault()
    mainWindow.hide()
  })

  mainWindow.on('resize', () => mainWindow && persistBounds(mainWindow))
  mainWindow.on('move', () => mainWindow && persistBounds(mainWindow))

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('bridge:info', (event) => {
    assertTrustedSender(event)
    return bridge?.getState().info ?? null
  })
  ipcMain.handle('bridge:state', (event) => {
    assertTrustedSender(event)
    return bridge?.getState() ?? { status: 'stopped', info: null, lastError: null, health: null }
  })
  ipcMain.handle('bridge:start', (event) => {
    assertTrustedSender(event)
    return bridge?.start() ?? Promise.reject(new Error('bridge not initialised'))
  })
  ipcMain.handle('shell:open-external', (event, url: unknown) => {
    assertTrustedSender(event)
    if (typeof url !== 'string') return
    return openExternal(url)
  })
  ipcMain.handle('hermes:read-settings', (event) => {
    assertTrustedSender(event)
    return readSettings()
  })
  ipcMain.handle('hermes:write-settings', (event, patch: unknown) => {
    assertTrustedSender(event)
    return updateSettings(sanitizeSettingsPatch(patch))
  })
  ipcMain.handle('hermes:detect', (event) => {
    assertTrustedSender(event)
    return detectHermesHome()
  })
  ipcMain.handle('hermes:pick', (event) => {
    assertTrustedSender(event)
    return pickHermesHome()
  })
  ipcMain.handle('hermes:restart-bridge', async (event) => {
    assertTrustedSender(event)
    if (!bridge) return null
    await bridge.stop()
    return bridge.start()
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.hermes.manager')
    installSecurityPolicy()
    bridge = new BridgeSupervisor(app.getPath('userData'))
    bridge.on('log', (line: string) => mainWindow?.webContents.send('bridge:log', line))
    bridge.on('error', (error: Error) => {
      const message = error instanceof Error ? error.message : String(error)
      mainWindow?.webContents.send('bridge:log', message)
      if (message.includes('No Python interpreter')) {
        // Trigger first-run wizard to locate Hermes install
        mainWindow?.webContents.send('bridge:hermes-home-missing')
      }
    })
    bridge.on('exit', () => {
      bridgeEverFailed = true
      // At most one OS notification per minute, never on shutdown.
      if (Date.now() - lastBridgeNotifyAt < 60_000) return
      lastBridgeNotifyAt = Date.now()
      notify(
        'Hermes bridge disconnected',
        bridge?.getState().lastError ?? 'the local bridge stopped unexpectedly',
      )
    })
    bridge.on('ready', () => {
      if (!bridgeEverFailed) return
      bridgeEverFailed = false
      lastBridgeNotifyAt = Date.now()
      notify('Hermes bridge reconnected', 'the local bridge is healthy again')
    })
    registerIpc()
    createWindow()
    createTray(() => mainWindow)

    try {
      await bridge.start()
    } catch (error) {
      mainWindow?.webContents.send(
        'bridge:log',
        `bridge failed to start: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('render-process-gone', (_event, contents, details) => {
  if (details.reason === 'clean-exit') return
  mainWindow?.webContents.send('bridge:log', `renderer gone (${details.reason}); reloading`)
  if (rendererCrashCount < 2 && !contents.isDestroyed()) {
    rendererCrashCount += 1
    contents.reload()
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  markQuitting()
  if (!bridge) return
  event.preventDefault()
  const instance = bridge
  bridge = null
  void instance.stop().finally(() => {
    destroyTray()
    app.quit()
  })
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const devServer = isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '')
    if (!devServer) event.preventDefault()
  })
})
