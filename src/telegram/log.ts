/**
 * Telegram Observer — logging policy (Tier 0).
 *
 * Decides what reaches the database. Everything here is deterministic and free:
 * no model calls, no network. Extraction of facts and tasks is a later phase and
 * deliberately not wired in yet.
 */

import type { TelegramClient, Api } from 'telegram'
import { getDisplayName } from 'telegram/Utils.js'
import {
  upsertChat, getChat, insertMessage, markEdited, markDeletedByMsgId,
  setChatUnread, getCursor, listChats, type ChatMode,
} from './db.js'
import { classifyEntity, defaultModeFor, mediaTypeOf } from './client.js'

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

  const mode = defaultModeFor(info.kind)
  upsertChat({ ...info, defaultMode: mode })
  return { chat_id: info.chat_id, mode }
}

async function senderNameOf(message: Api.Message): Promise<string> {
  try {
    const sender = await message.getSender()
    return sender ? getDisplayName(sender as never) : ''
  } catch {
    return ''
  }
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

  const stored = insertMessage({
    chat_id: chat.chat_id,
    msg_id: message.id,
    direction: message.out ? 'out' : 'in',
    sender_id: message.senderId ? String(message.senderId) : null,
    sender_name: await senderNameOf(message),
    text,
    media_type: media,
    reply_to: message.replyTo?.replyToMsgId ?? null,
    ts: message.date,
  })

  if (stored) stats.stored++
}

export async function handleEditedMessage(message: Api.Message): Promise<void> {
  const chat = await resolveChatFor(message)
  if (!chat || !LOGGING_MODES.includes(chat.mode)) return
  markEdited(chat.chat_id, message.id, message.message ?? '')
}

/** Telegram gives no chat for deletions outside channels — match on id alone. */
export function handleDeletedMessages(ids: number[]): void {
  for (const id of ids) markDeletedByMsgId(id)
}

/** How many messages to pull for a chat the log has never seen. */
const CATCHUP_FIRST_SEEN = 20
/** Upper bound per chat when resuming from a cursor, so a long outage cannot stall startup. */
const CATCHUP_MAX = 200
/** Pause between chats — a burst of history requests is what earns a FloodWait. */
const CATCHUP_DELAY_MS = 350

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
): Promise<CatchUpResult> {
  const result: CatchUpResult = { chats: 0, stored: 0, floodWaits: 0 }

  for (const chat of listChats({ limit: 500 })) {
    if (chat.mode === 'ignore') continue

    const cursor = getCursor(chat.chat_id)
    const limit = cursor > 0 ? CATCHUP_MAX : CATCHUP_FIRST_SEEN

    try {
      const messages = await client.getMessages(chat.chat_id, {
        limit,
        // minId is exclusive: only what arrived after the last logged message.
        ...(cursor > 0 ? { minId: cursor } : {}),
      })

      let storedHere = 0
      for (const m of messages) {
        if (!m) continue
        const text = m.message ?? ''
        const media = mediaTypeOf(m)
        if (!text && !media) continue

        let senderName = ''
        try {
          const sender = await m.getSender()
          senderName = sender ? getDisplayName(sender as never) : ''
        } catch { /* sender unavailable */ }

        const stored = insertMessage({
          chat_id: chat.chat_id,
          msg_id: m.id,
          direction: m.out ? 'out' : 'in',
          sender_id: m.senderId ? String(m.senderId) : null,
          sender_name: senderName,
          text,
          media_type: media,
          reply_to: m.replyTo?.replyToMsgId ?? null,
          ts: m.date,
        })
        if (stored) storedHere++
      }

      if (storedHere > 0) {
        result.chats++
        result.stored += storedHere
        onProgress?.(`${chat.title}: +${storedHere}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('FLOOD_WAIT')) {
        result.floodWaits++
        onProgress?.(`${chat.title}: FloodWait, пропускаю`)
        // Back off hard rather than hammering the same limit.
        await sleep(5000)
        continue
      }
      onProgress?.(`${chat.title}: помилка — ${msg}`)
    }

    await sleep(CATCHUP_DELAY_MS)
  }

  return result
}

/** Refresh unread counters from the account's dialog list. */
export async function syncUnread(client: TelegramClient, limit = 100): Promise<void> {
  const dialogs = await client.getDialogs({ limit })
  for (const d of dialogs) {
    const info = classifyEntity(d.entity)
    if (!info) continue
    const existing = getChat(info.chat_id)
    if (!existing) {
      upsertChat({ ...info, defaultMode: defaultModeFor(info.kind) })
    } else {
      upsertChat({ ...info, defaultMode: existing.mode })
    }
    setChatUnread(info.chat_id, d.unreadCount ?? 0)
  }
}
