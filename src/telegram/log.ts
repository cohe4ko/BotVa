/**
 * Telegram Observer — logging policy (Tier 0).
 *
 * Decides what reaches the database. Everything here is deterministic and free:
 * no model calls, no network. Extraction of facts and tasks is a later phase and
 * deliberately not wired in yet.
 */

import type { TelegramClient, Api } from 'telegram'
import {
  upsertChat, getChat, insertMessage, markEdited, markDeletedByMsgId,
  setChatUnread, bumpUnread, touchChatActivity, getCursor, listChats, notePersonSeen,
  markExtractionsStale, type ChatMode,
} from './db.js'
import {
  classifyEntity, defaultModeFor, mediaTypeOf, senderNameFromCache,
  senderProfileFromCache, MAX_HISTORY,
} from './client.js'
import { throttled, parseFloodWait } from './throttle.js'

/** Modes in which a message is written to the log. */
const LOGGING_MODES: ChatMode[] = ['log-only', 'facts-only', 'full']

export interface LogStats {
  seen: number
  stored: number
  skipped: number
}

export const stats: LogStats = { seen: 0, stored: 0, skipped: 0 }

/**
 * Resolve the chat for a message, registering it on first sight.
 * Returns null when the chat cannot be classified (rare service updates).
 */
async function resolveChatFor(message: Api.Message): Promise<{ chat_id: string; mode: ChatMode } | null> {
  let entity: unknown
  try {
    entity = await message.getChat()
  } catch {
    return null
  }
  const info = classifyEntity(entity)
  if (!info) return null

  const existing = getChat(info.chat_id)
  if (existing) {
    // Keep metadata fresh, but never overwrite a mode the user has chosen.
    upsertChat({ ...info, defaultMode: existing.mode })
    return { chat_id: info.chat_id, mode: existing.mode }
  }

  const mode = defaultModeFor(info.kind, info.chat_id)
  upsertChat({ ...info, defaultMode: mode })
  return { chat_id: info.chat_id, mode }
}

/**
 * Sender name for a logged message.
 *
 * Reads the entity the update already carried. `getSender()` would resolve it
 * over the network on a cache miss — once per message — which is how a busy
 * chat turns into a request storm.
 */
function senderNameOf(message: Api.Message): string {
  return senderNameFromCache(message)
}

/** Handle a new incoming or outgoing message. */
export async function handleNewMessage(message: Api.Message): Promise<void> {
  stats.seen++
  const chat = await resolveChatFor(message)
  if (!chat || !LOGGING_MODES.includes(chat.mode)) {
    stats.skipped++
    return
  }

  const media = mediaTypeOf(message)
  const text = message.message ?? ''
  // Service messages with neither text nor media carry nothing worth storing.
  if (!text && !media) {
    stats.skipped++
    return
  }

  const senderId = message.senderId ? String(message.senderId) : null
  const stored = insertMessage({
    chat_id: chat.chat_id,
    msg_id: message.id,
    direction: message.out ? 'out' : 'in',
    sender_id: senderId,
    sender_name: senderNameOf(message),
    text,
    media_type: media,
    reply_to: message.replyTo?.replyToMsgId ?? null,
    ts: message.date,
  })

  if (stored) {
    stats.stored++
    // The people register is built from what the log already sees, so it costs
    // no extra request and fills in retroactively as conversations happen.
    // Only incoming: the owner is not a person in his own address book.
    if (!message.out && senderId) {
      const who = senderProfileFromCache(message)
      notePersonSeen({
        peer_id: senderId,
        display_name: who.name,
        username: who.username,
        is_bot: who.isBot,
        ts: message.date,
      })
    }
    // Track read state as it happens. The dialog sync only corrects this every
    // few minutes, and a policy that waits on unread cannot use a stale count.
    if (message.out) setChatUnread(chat.chat_id, 0)
    else bumpUnread(chat.chat_id, 1)
  }
}

export async function handleEditedMessage(message: Api.Message): Promise<void> {
  const chat = await resolveChatFor(message)
  if (!chat || !LOGGING_MODES.includes(chat.mode)) return
  markEdited(chat.chat_id, message.id, message.message ?? '')
  // Anything already extracted from this message rests on text that no longer
  // exists. It is flagged for another look, never removed behind the owner's
  // back — a fact that vanishes silently is worse than a stale one.
  markExtractionsStale(message.id, chat.chat_id)
}

/** Telegram gives no chat for deletions outside channels — match on id alone. */
export function handleDeletedMessages(ids: number[]): void {
  for (const id of ids) {
    markDeletedByMsgId(id)
    markExtractionsStale(id)
  }
}

/** How many messages to pull for a chat the log has never seen. */
const CATCHUP_FIRST_SEEN = 20
/** Upper bound per chat when resuming from a cursor, so a long outage cannot stall startup. */
const CATCHUP_MAX = 200
/** Pause between chats — a burst of history requests is what earns a FloodWait. */
const CATCHUP_DELAY_MS = 350
/**
 * Catch-up touches only recently active chats, and at most this many.
 *
 * An account can hold thousands of dialogs. Walking all of them on every start
 * would mean thousands of getHistory calls — a guaranteed FLOOD_WAIT and a
 * startup measured in tens of minutes, to recover conversations nobody is
 * having. Anything older is already reachable on demand via tg_read_chat.
 */
const CATCHUP_ACTIVE_DAYS = 7
const CATCHUP_MAX_CHATS = 30

/**
 * A chat with no activity for this long is registered as `ignore`.
 *
 * Long-dead dialogs would otherwise fill the registry and the admin list with
 * noise. The user can switch any of them on by hand; nothing is deleted.
 */
export const STALE_CHAT_DAYS = 30

const DAY_SECONDS = 86400

export interface CatchUpResult {
  chats: number
  stored: number
  floodWaits: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Pull messages that arrived while the daemon was down.
 *
 * MTProto delivers updates only to a live connection, so every restart would
 * otherwise leave a hole in the log. The cursor (highest msg_id per chat) marks
 * where to resume; a chat seen for the first time gets a small recent slice so
 * the archive is not empty, not a full backfill.
 */
export async function catchUp(
  client: TelegramClient,
  onProgress?: (msg: string) => void,
  opts?: { delayMs?: number },
): Promise<CatchUpResult> {
  const delayMs = opts?.delayMs ?? CATCHUP_DELAY_MS
  const result: CatchUpResult = { chats: 0, stored: 0, floodWaits: 0 }
  const activeSince = Math.floor(Date.now() / 1000) - CATCHUP_ACTIVE_DAYS * DAY_SECONDS

  const candidates = listChats({ activeSince, limit: CATCHUP_MAX_CHATS })
  onProgress?.(`перевіряю ${candidates.length} активних чатів`)

  for (const chat of candidates) {
    if (chat.mode === 'ignore') continue

    const cursor = getCursor(chat.chat_id)
    const limit = cursor > 0 ? CATCHUP_MAX : CATCHUP_FIRST_SEEN

    try {
      const messages = await throttled('catchUp.getMessages', () =>
        client.getMessages(chat.chat_id, {
          limit: Math.min(limit, MAX_HISTORY),
          // minId is exclusive: only what arrived after the last logged message.
          ...(cursor > 0 ? { minId: cursor } : {}),
        }))

      let storedHere = 0
      for (const m of messages) {
        if (!m) continue
        const text = m.message ?? ''
        const media = mediaTypeOf(m)
        if (!text && !media) continue

        // Never resolve senders one by one here: this loop runs across many
        // chats at startup, and a per-message lookup would multiply the cost.
        const senderId = m.senderId ? String(m.senderId) : null
        const senderName = senderNameFromCache(m)

        const stored = insertMessage({
          chat_id: chat.chat_id,
          msg_id: m.id,
          direction: m.out ? 'out' : 'in',
          sender_id: senderId,
          sender_name: senderName,
          text,
          media_type: media,
          reply_to: m.replyTo?.replyToMsgId ?? null,
          ts: m.date,
        })
        if (stored) {
          storedHere++
          if (!m.out && senderId) {
            const who = senderProfileFromCache(m)
            notePersonSeen({
              peer_id: senderId,
              display_name: who.name,
              username: who.username,
              is_bot: who.isBot,
              ts: m.date,
            })
          }
        }
      }

      if (storedHere > 0) {
        result.chats++
        result.stored += storedHere
        onProgress?.(`${chat.title}: +${storedHere}`)
      }
    } catch (err) {
      const wait = parseFloodWait(err)
      if (wait !== null) {
        result.floodWaits++
        // The throttle has already armed a global pause; stop catching up
        // entirely rather than walking into the same limit chat after chat.
        onProgress?.(`FloodWait ${wait}с — зупиняю добір, решта дочитається на наступному старті`)
        return result
      }
      onProgress?.(`${chat.title}: помилка — ${err instanceof Error ? err.message : String(err)}`)
    }

    await sleep(delayMs)
  }

  return result
}

/**
 * Refresh unread counters from the account's dialog list.
 *
 * `getDialogs` returns newest-first, so the limit keeps a thousand-dialog
 * account from dragging its whole history into the registry. A chat whose last
 * message predates STALE_CHAT_DAYS is registered as `ignore`: it stays visible
 * and switchable in the admin UI, but costs nothing until the user wants it.
 */
export async function syncUnread(client: TelegramClient, limit = 100): Promise<void> {
  const dialogs = await throttled('syncUnread.getDialogs', () => client.getDialogs({ limit }))
  const staleBefore = Math.floor(Date.now() / 1000) - STALE_CHAT_DAYS * DAY_SECONDS

  for (const d of dialogs) {
    const info = classifyEntity(d.entity)
    if (!info) continue

    const existing = getChat(info.chat_id)
    if (existing) {
      // Never override a mode the user has chosen.
      upsertChat({ ...info, defaultMode: existing.mode })
    } else {
      const lastTs = d.message?.date ?? 0
      const isStale = lastTs > 0 && lastTs < staleBefore
      upsertChat({ ...info, defaultMode: isStale ? 'ignore' : defaultModeFor(info.kind, info.chat_id) })
    }

    setChatUnread(info.chat_id, d.unreadCount ?? 0)
    // Recency drives both the admin ordering and catch-up eligibility, so it
    // must reflect the dialog list even before any message is logged.
    if (d.message?.date) touchChatActivity(info.chat_id, d.message.date)
  }
}
