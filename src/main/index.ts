import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { BridgeSupervisor } from './bridge-supervisor'
import { installSecurityPolicy, openExternal } from './security'
import { pickHermesHome, readSettings, updateSettings, type ManagerSettings } from './settings'
import { detectHermesHome } from './hermes-paths'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

let mainWindow: BrowserWindow | null = null
let bridge: BridgeSupervisor | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
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
      webviewTag: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url)
    return { action: 'deny' }
  })

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
  ipcMain.handle('bridge:info', () => bridge?.getState().info ?? null)
  ipcMain.handle('bridge:state', () => bridge?.getState() ?? { status: 'stopped', info: null, lastError: null, health: null })
  ipcMain.handle('bridge:start', () => bridge?.start() ?? Promise.reject(new Error('bridge not initialised')))
  ipcMain.handle('shell:open-external', (_event, url: string) => openExternal(url))
  ipcMain.handle('hermes:read-settings', () => readSettings())
  ipcMain.handle('hermes:write-settings', (_event, patch: unknown) => updateSettings(patch && typeof patch === 'object' ? patch as ManagerSettings : {}))
  ipcMain.handle('hermes:detect', () => detectHermesHome())
  ipcMain.handle('hermes:pick', () => pickHermesHome())
  ipcMain.handle('hermes:restart-bridge', async () => {
    if (!bridge) return null
    await bridge.stop()
    return bridge.start()
  })
}

app.whenReady().then(async () => {
  installSecurityPolicy()
  bridge = new BridgeSupervisor(app.getPath('userData'))
  bridge.on('log', (line: string) => mainWindow?.webContents.send('bridge:log', line))
  bridge.on('error', (err: string) => {
    mainWindow?.webContents.send('bridge:log', err)
    if (err.includes('No Python interpreter')) {
      // Trigger first-run wizard to locate Hermes install
      mainWindow?.webContents.send('bridge:hermes-home-missing')
    }
  })
  registerIpc()
  createWindow()

  try {
    await bridge.start()
  } catch (error) {
    mainWindow?.webContents.send('bridge:log', `bridge failed to start: ${String(error)}`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (!bridge) return
  event.preventDefault()
  const instance = bridge
  bridge = null
  void instance.stop().finally(() => app.quit())
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const devServer = isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '')
    if (!devServer) event.preventDefault()
  })
})
