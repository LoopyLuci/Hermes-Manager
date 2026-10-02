import { contextBridge, ipcRenderer } from 'electron'
import type { AppUpdateCheck, BridgeInfo, BridgeStateDto } from '../shared/protocol'

export type { AppUpdateCheck, BridgeStateDto } from '../shared/protocol'

export interface SettingsDto {
  hermesHome?: string
  theme?: 'dark' | 'light' | 'system'
  recentPaths?: string[]
}

const api = {
  bridgeInfo: (): Promise<BridgeInfo | null> => ipcRenderer.invoke('bridge:info'),
  bridgeState: (): Promise<BridgeStateDto> => ipcRenderer.invoke('bridge:state'),
  startBridge: (): Promise<BridgeInfo> => ipcRenderer.invoke('bridge:start'),
  restartBridge: (): Promise<BridgeInfo | null> => ipcRenderer.invoke('hermes:restart-bridge'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  readSettings: (): Promise<SettingsDto> => ipcRenderer.invoke('hermes:read-settings'),
  writeSettings: (patch: Partial<SettingsDto>): Promise<SettingsDto> =>
    ipcRenderer.invoke('hermes:write-settings', patch),
  detectHermesHome: (): Promise<string | null> => ipcRenderer.invoke('hermes:detect'),
  pickHermesHome: (): Promise<string | null> => ipcRenderer.invoke('hermes:pick'),
  checkAppUpdate: (): Promise<AppUpdateCheck> => ipcRenderer.invoke('app:check-update'),
  installAppUpdate: (): Promise<boolean> => ipcRenderer.invoke('app:install-update'),
  onBridgeLog: (listener: (line: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, line: string): void => listener(line)
    ipcRenderer.on('bridge:log', handler)
    return () => ipcRenderer.off('bridge:log', handler)
  },
  onHermesHomeMissing: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('bridge:hermes-home-missing', handler)
    return () => ipcRenderer.off('bridge:hermes-home-missing', handler)
  },
}

export type HermesApi = typeof api

contextBridge.exposeInMainWorld('hermes', api)
