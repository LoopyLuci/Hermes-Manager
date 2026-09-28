import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { readSettings } from './settings'

/** A directory counts as a Hermes home when it carries the usual markers. */
export function isHermesHome(dir: string): boolean {
  if (!dir) return false
  return existsSync(join(dir, 'hermes-agent')) || existsSync(join(dir, 'logs'))
}

/**
 * Resolution order: explicit override > HERMES_HOME > known locations.
 * Returns null when nothing can be found; the first-run wizard then asks.
 */
export function resolveHermesHome(_userDataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const override = readSettings().hermesHome
  if (override && isHermesHome(override)) return override

  const fromEnv = env.HERMES_HOME?.trim()
  if (fromEnv && isHermesHome(fromEnv)) return fromEnv

  const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const roaming = env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  for (const candidate of [join(localAppData, 'hermes'), join(roaming, 'hermes')]) {
    if (isHermesHome(candidate)) return candidate
  }
  return null
}

/** The hermes-agent checkout inside a Hermes home, when present. */
export function resolveHermesRepo(hermesHome: string | null): string | null {
  if (!hermesHome) return null
  const repo = join(hermesHome, 'hermes-agent')
  return existsSync(join(repo, 'pyproject.toml')) || existsSync(join(repo, 'hermes_cli')) ? repo : null
}

/** Best-effort discovery used by the first-run wizard. */
export function detectHermesHome(): string | null {
  return resolveHermesHome('')
}
