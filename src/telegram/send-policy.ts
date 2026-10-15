/**
 * Rules every message sent in the owner's name must pass, whichever way it
 * travels — through the observer's MTProto session or through Telegram
 * Business. One copy of the rules, so the two routes cannot drift apart.
 */

import { countOutboxSince, getChat } from './db.js'

/** Outgoing action limits — a hard refusal, never a queue. */
export const SEND_LIMIT_HOUR = 10
export const SEND_LIMIT_DAY = 30

/** Why sending is refused right now because of the shared limits, or null. */
export function checkSendLimits(nowTs = Math.floor(Date.now() / 1000)): string | null {
  if (countOutboxSince(nowTs - 3600) >= SEND_LIMIT_HOUR) {
    return `Ліміт вихідних вичерпано: ${SEND_LIMIT_HOUR} на годину.`
  }
  if (countOutboxSince(nowTs - 86400) >= SEND_LIMIT_DAY) {
    return `Ліміт вихідних вичерпано: ${SEND_LIMIT_DAY} на добу.`
  }
  return null
}

/** Whether the owner has allowed sending into this chat at all (admin: Telegram → Chats). */
export function isSendAllowed(chatId: string): boolean {
  return !!getChat(chatId)?.can_send
}
