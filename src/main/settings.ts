import { app, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
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
  } catch {
    // Missing/corrupt settings fall back to defaults below.
  }
  return {}
}

export function writeSettings(settings: ManagerSettings): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const target = settingsPath()
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
  renameSync(tmp, target)
}

export function sanitizeSettingsPatch(raw: unknown): Partial<ManagerSettings> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const input = raw as Record<string, unknown>
  const out: Partial<ManagerSettings> = {}
  if (typeof input.hermesHome === 'string' && input.hermesHome.length <= 1024)
    out.hermesHome = input.hermesHome
  if (input.theme === 'dark' || input.theme === 'light' || input.theme === 'system')
    out.theme = input.theme
  if (Array.isArray(input.recentPaths))
    out.recentPaths = input.recentPaths
      .filter((entry): entry is string => typeof entry === 'string' && entry.length <= 1024)
      .slice(0, 10)
  return out
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
    defaultPath: homedir(),
  })
  const chosen = filePaths[0]
  if (canceled || !chosen) return null
  if (!existsSync(join(chosen, 'hermes-agent'))) {
    // Cancelling returns null; picking a non-Hermes folder is an error the
    // wizard should surface, never the same signal as "backed out".
    throw new Error('That folder does not contain a hermes-agent checkout.')
  }
  return chosen
}
