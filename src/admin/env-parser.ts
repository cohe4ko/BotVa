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
