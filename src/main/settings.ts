import { app, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

const SETTINGS_FILE = 'hermes-manager-settings.json'

export interface ManagerSettings {
  hermesHome?: string
  theme?: 'dark' | 'light' | 'system'
  recentPaths?: string[]
}

export function settingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE)
}

export function readSettings(): ManagerSettings {
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as ManagerSettings
  } catch { }
  return {}
}

export function writeSettings(settings: ManagerSettings): void {
  const dir = join(app.getPath('userData'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}

export function updateSettings(patch: Partial<ManagerSettings>): ManagerSettings {
  const current = readSettings()
  const next = { ...current, ...patch }
  writeSettings(next)
  return next
}

export async function pickHermesHome(): Promise<string | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Hermes home directory',
    buttonLabel: 'Select',
    properties: ['openDirectory'],
    defaultPath: homedir()
  })
  const chosen = filePaths[0]
  if (canceled || !chosen) return null
  if (!existsSync(join(chosen, 'hermes-agent'))) return null
  return chosen
}