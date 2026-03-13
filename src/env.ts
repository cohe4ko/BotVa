import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// Bot name from BOT_NAME env var (required)
export const BOT_NAME = process.env.BOT_NAME ?? 'default'
export const BOT_DIR = resolve(PROJECT_ROOT, 'bots', BOT_NAME)

export function readEnvFile(keys?: string[]): Record<string, string> {
  // First try bot-specific .env, fallback to project root
  let envPath = resolve(BOT_DIR, '.env')
  if (!existsSync(envPath)) {
    envPath = resolve(PROJECT_ROOT, '.env')
  }
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
