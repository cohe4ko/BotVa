import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// Bot name from BOT_NAME env var (required)
export const BOT_NAME = process.env.BOT_NAME ?? 'default'
export const BOT_DIR = resolve(PROJECT_ROOT, 'bots', BOT_NAME)

function parseEnv(filePath: string, keys?: string[]): Record<string, string> {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
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

    // Handle quoted values
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (keys && !keys.includes(key)) continue
    result[key] = value
  }

  return result
}

export function readEnvFile(keys?: string[]): Record<string, string> {
  // Root .env as base (ADMIN_HOST, ADMIN_PORT, etc.), bot .env overrides
  const rootPath = resolve(PROJECT_ROOT, '.env')
  const botPath = resolve(BOT_DIR, '.env')

  const root = existsSync(rootPath) ? parseEnv(rootPath, keys) : {}
  const bot = existsSync(botPath) ? parseEnv(botPath, keys) : {}

  return { ...root, ...bot }
}
