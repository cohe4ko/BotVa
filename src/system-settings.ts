import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

interface SystemSettings {
  consolidationHour: number
}

const DEFAULTS: SystemSettings = {
  consolidationHour: 4,
}

let settingsPath: string | null = null

function getPath(projectRoot?: string): string {
  if (!settingsPath) {
    const root = projectRoot ?? resolve(import.meta.dirname, '..')
    settingsPath = resolve(root, 'workspace', 'system-settings.json')
  }
  return settingsPath
}

export function getSystemSettings(projectRoot?: string): SystemSettings {
  const path = getPath(projectRoot)
  try {
    if (existsSync(path)) {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf-8')) }
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS }
}

export function setSystemSetting<K extends keyof SystemSettings>(key: K, value: SystemSettings[K], projectRoot?: string): void {
  const path = getPath(projectRoot)
  const settings = getSystemSettings(projectRoot)
  settings[key] = value
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
}

export function getConsolidationHour(projectRoot?: string): number {
  return getSystemSettings(projectRoot).consolidationHour
}
