/**
 * Telegram ids of the bots that belong to this installation.
 *
 * With Bot-to-Bot Communication Mode on, any bot in a group can now reach
 * ours by mentioning it. Only our own bots should be able to start a turn
 * that way; everyone else's bot is an outsider. A bot token is
 * `<bot id>:<secret>`, so the ids come straight from bots/<name>/.env
 * without asking Telegram.
 */

import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

const CACHE_MS = 60_000

let cached: { at: number; ids: Set<number> } | null = null

/** The numeric bot id encoded in a token, or null. */
export function botIdFromToken(token: string | undefined): number | null {
  const m = /^(\d{5,})\s*:\s*[\w-]+$/.exec((token ?? '').trim())
  return m ? Number(m[1]) : null
}

function tokenOf(envFile: string): string | undefined {
  try {
    const line = readFileSync(envFile, 'utf8').split('\n').find(l => /^\s*TELEGRAM_BOT_TOKEN\s*=/.test(l))
    return line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

/** Ids of every bot configured under `<projectRoot>/bots`, cached for a minute. */
export function teamBotIds(projectRoot: string, now = Date.now()): Set<number> {
  if (cached && now - cached.at < CACHE_MS) return cached.ids
  const ids = new Set<number>()
  const dir = join(projectRoot, 'bots')
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const id = botIdFromToken(tokenOf(join(dir, name, '.env')))
      if (id) ids.add(id)
    }
  }
  cached = { at: now, ids }
  return ids
}

export function _resetTeamBotsCache(): void {
  cached = null
}
