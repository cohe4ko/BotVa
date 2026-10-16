/**
 * Managed bots (Bot API): create and look after the owner's bots without
 * @BotFather.
 *
 * A bot that has bot management enabled (in the @BotFather Mini App, once)
 * sends the owner an inline button with a creation link
 * (t.me/newbot/<manager>/<username>?name=...). Pressing it opens Telegram's
 * own "create a bot" sheet with our suggested name and username; the owner
 * confirms, and becomes the new bot's owner. Telegram then tells us about it
 * with a `managed_bot` update, and the new bot's token is ours to fetch with
 * getManagedBotToken. From there it is the regular CreateBot path.
 *
 * Not the reply-keyboard `request_managed_bot` button: Telegram for iOS opens
 * a generic share sheet for it instead of the creation sheet (Oct 2026).
 *
 * Creation always needs that one tap: a bot is never made silently.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { Api } from 'grammy'
import type { InlineKeyboardMarkup } from 'grammy/types'
import { logger } from './logger.js'

/** What CreateBot was asked for, kept until the owner confirms in Telegram. */
export interface ManagedBotRequest {
  chatId: string
  name: string
  role?: string
  displayName?: string
  emoji?: string
  personality?: string
  autoStart?: boolean
  createdAt: number
}

/** A request the owner has not confirmed within this window is dropped. */
const REQUEST_TTL_MS = 30 * 60 * 1000

// One pending request per chat: the service message names the bot, not the request
const pending = new Map<string, ManagedBotRequest>()

export function addPendingRequest(req: ManagedBotRequest): void {
  pending.set(req.chatId, req)
}

/** Take (and forget) the chat's pending request, if it is still fresh. */
export function takePendingRequest(chatId: string, now = Date.now()): ManagedBotRequest | undefined {
  const req = pending.get(chatId)
  pending.delete(chatId)
  if (!req || now - req.createdAt > REQUEST_TTL_MS) return undefined
  return req
}

export function _resetManagedBotsForTests(): void {
  pending.clear()
}

/** A username Telegram will take: letters, digits, underscores, ending in "bot". */
export function suggestUsername(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 26) || 'botva'
  return /bot$/i.test(base) ? base : `${base}_bot`
}

/** The managed bot creation link (core.telegram.org/api/links). */
export function createBotLink(managerUsername: string, req: Pick<ManagedBotRequest, 'name' | 'displayName'>): string {
  const name = (req.displayName || req.name).slice(0, 64)
  return `https://t.me/newbot/${managerUsername}/${suggestUsername(req.name)}?name=${encodeURIComponent(name)}`
}

/** The button that opens Telegram's bot creation sheet. */
export function requestKeyboard(label: string, managerUsername: string, req: Pick<ManagedBotRequest, 'name' | 'displayName'>): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: label, url: createBotLink(managerUsername, req) }]] }
}

/**
 * This bot's username if it may create bots (switched on in the @BotFather
 * Mini App), otherwise undefined.
 */
export async function managerUsername(api: Api): Promise<string | undefined> {
  try {
    const me = await api.getMe() as { username?: string; can_manage_bots?: boolean }
    return me.can_manage_bots && me.username ? me.username : undefined
  } catch {
    return undefined
  }
}

/**
 * The owner confirmed a bot in Telegram: fetch its token, create it here,
 * keep it to the owner alone, and start it if asked. Returns a line for the chat.
 */
export async function completeManagedBot(api: Api, req: ManagedBotRequest, bot: { id: number; username?: string }): Promise<string> {
  const token = await api.getManagedBotToken(bot.id)
  const { createBot } = await import('./bot-manager.js')
  const result = createBot({
    name: req.name,
    token,
    role: req.role,
    displayName: req.displayName,
    emoji: req.emoji,
    personality: req.personality,
    chatId: req.chatId,
  })
  // Only the owner may talk to it — enforced by Telegram, on top of ALLOWED_CHAT_ID
  try {
    await api.setManagedBotAccessSettings(bot.id, true)
  } catch (err) {
    logger.warn({ err, bot: bot.username }, 'Could not restrict access to the managed bot')
  }
  let started = false
  if (req.autoStart) {
    const { startBot } = await import('./admin/bot-control.js')
    startBot(result.name)
    started = true
  }
  logger.info({ name: result.name, bot: bot.username, started }, 'Managed bot created')
  return `@${bot.username ?? result.name} → ${result.name}${started ? ' ▶️' : ''}`
}

/** The bot id is the part of a token before the colon. */
export function botIdFromToken(token: string): number | undefined {
  const id = Number(token.split(':')[0])
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** Swap TELEGRAM_BOT_TOKEN in a bot's .env, keeping every other line. */
export function replaceTokenInEnv(env: string, token: string): string {
  const lines = env.split('\n')
  const i = lines.findIndex(l => /^TELEGRAM_BOT_TOKEN=/.test(l))
  if (i >= 0) lines[i] = `TELEGRAM_BOT_TOKEN=${token}`
  else lines.unshift(`TELEGRAM_BOT_TOKEN=${token}`)
  return lines.join('\n')
}

/**
 * Revoke a managed bot's token and write the new one into its .env. The bot
 * has to restart to use it; the caller does that.
 */
export async function rotateManagedBotToken(api: Api, projectRoot: string, name: string): Promise<void> {
  const envPath = resolve(projectRoot, 'bots', name, '.env')
  if (!existsSync(envPath)) throw new Error(`Bot "${name}" not found`)
  const env = readFileSync(envPath, 'utf-8')
  const current = env.match(/^TELEGRAM_BOT_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  const id = botIdFromToken(current)
  if (!id) throw new Error(`Bot "${name}" has no valid token in .env`)
  // Fails unless this bot manages that one
  const token = await api.replaceManagedBotToken(id)
  writeFileSync(envPath, replaceTokenInEnv(env, token))
}
