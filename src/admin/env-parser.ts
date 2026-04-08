import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { getBotDir, getProjectRoot, type BotName } from './db-multi.js'

export function getEnvPath(bot: BotName): string {
  const botEnv = resolve(getBotDir(bot), '.env')
  if (existsSync(botEnv)) return botEnv
  return resolve(getProjectRoot(), '.env')
}

export function readEnv(bot: BotName): Record<string, string> {
  const envPath = getEnvPath(bot)
  let content: string
  try {
    content = readFileSync(envPath, 'utf-8')
  } catch {
    return {}
  }

  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

export function readEnvRaw(bot: BotName): string {
  const envPath = getEnvPath(bot)
  try {
    return readFileSync(envPath, 'utf-8')
  } catch {
    return ''
  }
}

export function writeEnvRaw(bot: BotName, content: string): void {
  // Always write to bot-specific .env
  const envPath = resolve(getBotDir(bot), '.env')
  writeFileSync(envPath, content, 'utf-8')
}

/**
 * Update or insert specific keys in bot-specific .env, preserving all other lines, comments
 * and formatting. Pass empty string to delete a key.
 */
export function updateEnvKeys(bot: BotName, updates: Record<string, string>): void {
  const envPath = resolve(getBotDir(bot), '.env')
  let content = ''
  try { content = readFileSync(envPath, 'utf-8') } catch { content = '' }
  const lines = content.split('\n')
  const remaining = new Map(Object.entries(updates))

  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) { out.push(line); continue }
    const eq = trimmed.indexOf('=')
    if (eq === -1) { out.push(line); continue }
    const key = trimmed.slice(0, eq).trim()
    if (!remaining.has(key)) { out.push(line); continue }
    const newVal = remaining.get(key)!
    remaining.delete(key)
    if (newVal === '') continue // delete
    out.push(`${key}=${quoteIfNeeded(newVal)}`)
  }
  for (const [key, val] of remaining) {
    if (val === '') continue
    out.push(`${key}=${quoteIfNeeded(val)}`)
  }
  // Ensure trailing newline
  const final = out.join('\n').replace(/\n*$/, '') + '\n'
  writeFileSync(envPath, final, 'utf-8')
}

function quoteIfNeeded(v: string): string {
  if (/[\s#'"$`\\]/.test(v)) return `"${v.replace(/"/g, '\\"')}"`
  return v
}

/** Read root-level .env (shared across all bots). */
export function readRootEnv(): Record<string, string> {
  const p = resolve(getProjectRoot(), '.env')
  let content: string
  try { content = readFileSync(p, 'utf-8') } catch { return {} }
  const out: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    out[key] = val
  }
  return out
}

/** Update specific keys in root .env, preserving comments and layout. Empty string deletes. */
export function updateRootEnvKeys(updates: Record<string, string>): void {
  const envPath = resolve(getProjectRoot(), '.env')
  let content = ''
  try { content = readFileSync(envPath, 'utf-8') } catch { content = '' }
  const lines = content.split('\n')
  const remaining = new Map(Object.entries(updates))
  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) { out.push(line); continue }
    const eq = trimmed.indexOf('=')
    if (eq === -1) { out.push(line); continue }
    const key = trimmed.slice(0, eq).trim()
    if (!remaining.has(key)) { out.push(line); continue }
    const newVal = remaining.get(key)!
    remaining.delete(key)
    if (newVal === '') continue
    out.push(`${key}=${quoteIfNeeded(newVal)}`)
  }
  for (const [key, val] of remaining) {
    if (val === '') continue
    out.push(`${key}=${quoteIfNeeded(val)}`)
  }
  const final = out.join('\n').replace(/\n*$/, '') + '\n'
  writeFileSync(envPath, final, 'utf-8')
}

export function readClaudeMd(bot: BotName): string {
  const p = resolve(getBotDir(bot), 'CLAUDE.md')
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

export function writeClaudeMd(bot: BotName, content: string): void {
  const p = resolve(getBotDir(bot), 'CLAUDE.md')
  writeFileSync(p, content, 'utf-8')
}

export function readRoleMd(bot: BotName): string | null {
  const p = resolve(getBotDir(bot), 'role.md')
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf-8')
}

export function writeRoleMd(bot: BotName, content: string): void {
  writeFileSync(resolve(getBotDir(bot), 'role.md'), content, 'utf-8')
}
