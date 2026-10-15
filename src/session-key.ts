/**
 * Session keys and topic threads — the `session_mode` setting.
 *
 * - `name` (default): one conversation per chat, named with NameSession, as
 *   before. The session key is the chat id.
 * - `topics`: every forum topic of the private chat (Bot API 9.3+, enabled for
 *   the bot in @BotFather) is a conversation of its own. The key becomes
 *   `<chat id>:t<thread id>`, and every message the bot sends while handling
 *   that topic goes back into it.
 *
 * Messages outside any topic (or a bot without topics enabled) keep the plain
 * chat key, so switching the setting on changes nothing until topics exist.
 */

import type { Context } from 'grammy'
import { getChatSetting } from './db.js'

export type SessionMode = 'name' | 'topics'

export const SESSION_MODES: SessionMode[] = ['name', 'topics']

export function getSessionMode(chatId: string | number): SessionMode {
  return getChatSetting(String(chatId), 'session_mode') === 'topics' ? 'topics' : 'name'
}

export function sessionKey(chatId: string | number, threadId: number | undefined, mode: SessionMode): string {
  return mode === 'topics' && threadId ? `${chatId}:t${threadId}` : String(chatId)
}

/** The chat a session key belongs to. */
export function chatOfKey(key: string): string {
  return key.split(':t')[0]
}

/** The topic thread a private-chat update belongs to, if any. */
export function threadOf(ctx: Context): number | undefined {
  if (ctx.chat?.type !== 'private') return undefined
  const m = ctx.msg ?? ctx.callbackQuery?.message
  if (!m) return undefined
  // A message inside a topic carries its thread id; the General area has none.
  const t = (m as { message_thread_id?: number }).message_thread_id
  return typeof t === 'number' && t > 0 ? t : undefined
}

/** The session key for whatever this update is about. */
export function keyOf(ctx: Context): string {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return ''
  return sessionKey(chatId, threadOf(ctx), getSessionMode(chatId))
}

/** Bot API methods whose target can be a topic thread. */
const THREADED = /^(send[A-Z]\w*|copyMessage|copyMessages|forwardMessage|forwardMessages)$/

/**
 * Make every message this update sends to its own chat land in `threadId`.
 *
 * Installed on `ctx.api`, which grammY creates per update — so it covers the
 * progress reporter, rich messages, AskUser, permission prompts and the
 * builtin tools of this one turn, and nothing else. A call that already names
 * a thread, or targets another chat, is left alone.
 */
export function routeIntoThread(ctx: Context, threadId: number): void {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return
  ctx.api.config.use((prev, method, payload, signal) => {
    const p = payload as Record<string, unknown> | undefined
    if (p && THREADED.test(method) && String(p.chat_id) === String(chatId) && p.message_thread_id === undefined) {
      return prev(method, { ...p, message_thread_id: threadId } as typeof payload, signal)
    }
    return prev(method, payload, signal)
  })
}
