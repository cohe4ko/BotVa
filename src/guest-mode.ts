/**
 * Guest AI Bots (Bot API 10.0, May 2026)
 *
 * Allows the bot to respond to messages in chats it's NOT a member of.
 * A user tags @bot in any chat, and the bot receives a `guest_message` update
 * with limited context (only the specific message, no chat history).
 *
 * Security:
 * - Only responds to authorised users (ALLOWED_CHAT_ID)
 * - Confined to GUEST_ALLOWED_TOOLS: no side-effect tools, no external MCP
 * - Agent runs against user's personal session (not the guest chat)
 * - Responses are text-only
 */

import { ALLOWED_CHAT_ID } from './config.js'
import { logger } from './logger.js'
import { builtinToolId, type RunRestrictions } from './run-restrictions.js'

// Tools a guest run may call. The answer lands in a chat the bot is not a
// member of, so nothing here acts on the world: no media, no files, no
// reminders, no messages. RunPython is left out on purpose — it sends its
// figures with ctx.replyWithPhoto, and a guest update has no chat to send to.
export const GUEST_CORE_TOOLS = ['WebSearch', 'WebFetch']
export const GUEST_BUILTIN_TOOLS = [
  'CurrencyRates', 'GetCurrentTime', 'SearchMemory', 'ReadWorkspaceFile',
  'AskGemini', 'GeminiSearch',
]
export const GUEST_ALLOWED_TOOLS = [...GUEST_CORE_TOOLS, ...GUEST_BUILTIN_TOOLS]

// External MCP servers available to a guest run: none.
export const GUEST_MCP_ALLOW_LIST: string[] = []

/** The allowlist a guest run is confined to (enforced in run-restrictions.ts). */
export function guestRestrictions(): RunRestrictions {
  return { allowTools: [...GUEST_CORE_TOOLS, ...GUEST_BUILTIN_TOOLS.map(builtinToolId)] }
}

export interface GuestMessage {
  guest_query_id: string
  from: {
    id: number
    is_bot: boolean
    first_name: string
    last_name?: string
    username?: string
  }
  chat: {
    id: number
    type: string
    title?: string
  }
  message_id: number
  date: number
  text?: string
  entities?: Array<{
    type: string
    offset: number
    length: number
  }>
  // May contain photo, document etc. - we only handle text for now
}

/**
 * Check if a user is authorised to use guest queries.
 */
export function isGuestAuthorised(userId: number): boolean {
  if (!ALLOWED_CHAT_ID) return false
  const allowed = ALLOWED_CHAT_ID.split(',').map(s => s.trim())
  return allowed.includes(String(userId))
}

/**
 * Clean guest text: remove the @bot mention that triggered the query.
 * Returns the text without the first bot mention.
 */
export function cleanGuestText(
  text: string,
  botUsername: string,
  entities?: Array<{ type: string; offset: number; length: number }>
): string {
  if (!text) return ''

  // Remove @botUsername mention (case-insensitive)
  const mentionPattern = new RegExp(`@${botUsername}\\s*`, 'i')
  const cleaned = text.replace(mentionPattern, '').trim()

  return cleaned || text.trim()
}

/**
 * Build context prefix for guest mode agent.
 */
export function buildGuestContext(chatTitle?: string): string {
  const parts = [
    '[GUEST MODE] You were tagged in an external chat.',
    chatTitle ? `Chat: "${chatTitle}".` : '',
    'Respond with text only. No media, no files, no reminders, no actions in this chat.',
    'Keep responses concise - this is a quick-answer context.',
    `Available tools: ${GUEST_ALLOWED_TOOLS.join(', ')}.`,
  ]
  return parts.filter(Boolean).join(' ')
}

/**
 * Rate limiter for guest queries (per user).
 * Prevents abuse in large groups.
 */
const guestRateLimit = new Map<number, { count: number; windowStart: number }>()
const GUEST_RATE_LIMIT = 10          // max queries per window
const GUEST_RATE_WINDOW_MS = 60_000  // 1 minute window

export function checkGuestRateLimit(userId: number): boolean {
  const now = Date.now()
  const entry = guestRateLimit.get(userId)

  if (!entry || now - entry.windowStart > GUEST_RATE_WINDOW_MS) {
    guestRateLimit.set(userId, { count: 1, windowStart: now })
    return true
  }

  if (entry.count >= GUEST_RATE_LIMIT) {
    logger.warn({ userId, count: entry.count }, 'Guest rate limit exceeded')
    return false
  }

  entry.count++
  return true
}
