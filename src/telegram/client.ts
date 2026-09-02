/**
 * Telegram Observer — MTProto client wrapper (GramJS).
 *
 * Owns the session file, entity classification and the small set of account
 * actions the daemon exposes. Deliberately thin: no logging policy, no MCP
 * concerns — those live in log.ts and mcp.ts.
 */

import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { getPeerId, getDisplayName } from 'telegram/Utils.js'
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { TG_SESSION_PATH, PROJECT_ROOT } from './paths.js'
import { throttled, typingDelayMs } from './throttle.js'
import type { ChatKind, ChatMode } from './db.js'

/** Hard caps on how much a single call may ask for, regardless of the caller. */
export const MAX_DIALOGS = 100
export const MAX_HISTORY = 100

export interface ApiCredentials {
  apiId: number
  apiHash: string
}

/**
 * Read credentials from process.env, falling back to the project-level .env.
 *
 * The daemon and the admin UI run in different processes; both need the same
 * two values, and neither is a per-bot concern, so they live in the root .env.
 */
export function readCredentials(env: NodeJS.ProcessEnv = process.env): ApiCredentials | null {
  let apiId = Number(env['TELEGRAM_API_ID'] ?? '')
  let apiHash = env['TELEGRAM_API_HASH'] ?? ''

  if (!apiId || !apiHash) {
    const fromFile = readProjectEnv()
    apiId = apiId || Number(fromFile['TELEGRAM_API_ID'] ?? '')
    apiHash = apiHash || (fromFile['TELEGRAM_API_HASH'] ?? '')
  }

  if (!apiId || !apiHash) return null
  return { apiId, apiHash }
}

function readProjectEnv(): Record<string, string> {
  const envPath = resolve(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return {}
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      out[key] = value
    }
  } catch { /* unreadable .env is the same as absent */ }
  return out
}

// --- Session file ---

export function loadSession(): string {
  if (!existsSync(TG_SESSION_PATH)) return ''
  try {
    return readFileSync(TG_SESSION_PATH, 'utf-8').trim()
  } catch {
    return ''
  }
}

/** Persist the session string with owner-only permissions. */
export function saveSession(session: string): void {
  mkdirSync(dirname(TG_SESSION_PATH), { recursive: true })
  writeFileSync(TG_SESSION_PATH, session, 'utf-8')
  try { chmodSync(TG_SESSION_PATH, 0o600) } catch { /* best effort on exotic filesystems */ }
}

export function hasSession(): boolean {
  return loadSession().length > 0
}

// --- Client ---

export function createClient(creds: ApiCredentials, session = loadSession()): TelegramClient {
  return new TelegramClient(new StringSession(session), creds.apiId, creds.apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
    autoReconnect: true,
    // GramJS logs verbosely at info level; the daemon has its own logging.
    baseLogger: undefined,
  })
}

/** Connect and verify the stored session is still valid. */
export async function connectAuthorized(client: TelegramClient): Promise<boolean> {
  await client.connect()
  return client.isUserAuthorized()
}

// --- Entity classification ---

export interface ChatInfo {
  chat_id: string
  title: string
  username: string | null
  kind: ChatKind
}

/**
 * Map a Telegram entity to our chat registry shape.
 * `getPeerId` gives the marked id (-100… for channels), stable across sessions.
 */
export function classifyEntity(entity: Api.TypeUser | Api.TypeChat | Api.TypeInputPeer | unknown): ChatInfo | null {
  if (!entity || typeof entity !== 'object') return null

  // Structural read: the concrete Api classes have conflicting shapes, so an
  // intersection type collapses to never. className is the discriminator.
  const e = entity as { className?: string; bot?: boolean; megagroup?: boolean; username?: string }
  let kind: ChatKind

  switch (e.className) {
    case 'User':
      kind = e.bot ? 'bot' : 'user'
      break
    case 'Chat':
    case 'ChatForbidden':
      kind = 'group'
      break
    case 'Channel':
    case 'ChannelForbidden':
      kind = e.megagroup ? 'supergroup' : 'channel'
      break
    default:
      return null
  }

  let chat_id: string
  try {
    chat_id = getPeerId(entity as never)
  } catch {
    return null
  }

  return {
    chat_id,
    title: getDisplayName(entity as never) || chat_id,
    username: e.username ?? null,
    kind,
  }
}

/**
 * Telegram's own service account. It delivers login codes and security alerts —
 * one-time secrets that must never be written to a plaintext database.
 */
export const SERVICE_CHAT_ID = '777000'

/**
 * Default logging mode for a freshly seen chat.
 *
 * Bots are hard-ignored: BotVa's own bots message the same account, and logging
 * them would feed the observer its own output.
 */
export function defaultModeFor(kind: ChatKind, chatId?: string): ChatMode {
  if (chatId === SERVICE_CHAT_ID) return 'ignore'
  switch (kind) {
    case 'bot': return 'ignore'
    case 'user': return 'log-only'
    case 'group': return 'log-only'
    case 'supergroup': return 'ignore'
    case 'channel': return 'ignore'
  }
}

// --- Account actions ---

export interface DialogSummary {
  chat_id: string
  title: string
  username: string | null
  kind: ChatKind
  unread: number
  last_message: string
  last_ts: number | null
}

export async function listDialogs(client: TelegramClient, limit = 100): Promise<DialogSummary[]> {
  const dialogs = await throttled('getDialogs', () => client.getDialogs({ limit: Math.min(limit, MAX_DIALOGS) }))
  const out: DialogSummary[] = []
  for (const d of dialogs) {
    const info = classifyEntity(d.entity)
    if (!info) continue
    out.push({
      ...info,
      unread: d.unreadCount ?? 0,
      last_message: d.message?.message?.slice(0, 200) ?? '',
      last_ts: d.message?.date ?? null,
    })
  }
  return out
}

export interface HistoryMessage {
  msg_id: number
  direction: 'in' | 'out'
  /** Needed to tell participants apart in a group, and to seed the log faithfully. */
  sender_id: string | null
  sender_name: string
  text: string
  media_type: string | null
  reply_to: number | null
  ts: number
}

export async function getHistory(
  client: TelegramClient,
  chat: string,
  limit = 30,
): Promise<HistoryMessage[]> {
  const messages = await throttled('getMessages', () =>
    client.getMessages(chat, { limit: Math.min(limit, MAX_HISTORY) }))

  const out: HistoryMessage[] = []
  for (const m of messages) {
    if (!m) continue
    out.push({
      msg_id: m.id,
      direction: m.out ? 'out' : 'in',
      sender_id: m.senderId ? String(m.senderId) : null,
      sender_name: senderNameFromCache(m),
      text: m.message ?? '',
      media_type: mediaTypeOf(m),
      reply_to: m.replyTo?.replyToMsgId ?? null,
      ts: m.date,
    })
  }
  return out.reverse() // chronological
}

/**
 * Sender name without a network round-trip.
 *
 * `message.getSender()` resolves the entity, and on a cache miss that is a
 * separate API call — once per message. Reading a 200-message history would
 * then cost 200 extra requests, which is exactly the pattern that earns a
 * FLOOD_WAIT. An unnamed sender is a cosmetic loss; a rate limit is not.
 */
export function senderNameFromCache(message: unknown): string {
  const m = message as {
    _sender?: unknown
    sender?: unknown
    out?: boolean
    senderId?: unknown
  }
  const cached = m._sender ?? m.sender
  if (cached) {
    try {
      const name = getDisplayName(cached as never)
      if (name) return name
    } catch { /* entity shape not nameable */ }
  }
  // No cached entity: leave the name empty rather than storing a bare numeric
  // id. A reader — human or model — takes "700100200" for a participant, and
  // callers already have the chat title to fall back on.
  return ''
}

export function mediaTypeOf(message: { media?: unknown }): string | null {
  const media = message.media as { className?: string } | undefined
  if (!media?.className) return null
  switch (media.className) {
    case 'MessageMediaPhoto': return 'photo'
    case 'MessageMediaDocument': return 'document'
    case 'MessageMediaWebPage': return null // link preview, not an attachment
    case 'MessageMediaGeo':
    case 'MessageMediaGeoLive': return 'location'
    case 'MessageMediaContact': return 'contact'
    case 'MessageMediaPoll': return 'poll'
    default: return media.className.replace(/^MessageMedia/, '').toLowerCase()
  }
}

/**
 * Send text, preceded by a typing indicator and a delay scaled to its length.
 *
 * An instant reply is the clearest signal that nobody typed it. The indicator
 * also makes the pause read as normal to the person on the other side.
 */
export async function sendText(client: TelegramClient, chat: string, text: string): Promise<number> {
  const delay = typingDelayMs(text)
  try {
    await throttled('setTyping', () => client.invoke(new Api.messages.SetTyping({
      peer: chat,
      action: new Api.SendMessageTypingAction(),
    })))
  } catch { /* the indicator is cosmetic — never block the send on it */ }

  await new Promise(resolve => setTimeout(resolve, delay))

  const msg = await throttled('sendMessage', () => client.sendMessage(chat, { message: text }))
  return msg.id
}

export async function sendFile(
  client: TelegramClient,
  chat: string,
  path: string,
  caption?: string,
  asDocument = false,
): Promise<number> {
  const msg = await throttled('sendFile', () => client.sendFile(chat, {
    file: path,
    caption,
    forceDocument: asDocument,
  }))
  return msg.id
}

export async function resolveChat(client: TelegramClient, query: string): Promise<ChatInfo | null> {
  try {
    const entity = await throttled('getEntity', () => client.getEntity(query))
    return classifyEntity(entity)
  } catch {
    return null
  }
}

export async function markRead(client: TelegramClient, chat: string): Promise<void> {
  await throttled('markAsRead', () => client.markAsRead(chat))
}

/**
 * Only the owner's own messages in a chat.
 *
 * Server-side filtering, not a scan: `fromUser` turns this into one
 * `messages.search` with a sender filter, so a group where the owner wrote
 * twenty lines among ten thousand costs the same as any other history read.
 *
 * This is what makes style work in a group. Reading the last four hundred
 * messages of a busy room yields a handful of his lines drowned in everyone
 * else's; asking for his alone gives the same budget spent entirely on signal.
 */
export async function getOwnHistory(
  client: TelegramClient,
  chat: string,
  limit = 50,
): Promise<HistoryMessage[]> {
  const messages = await throttled('getMessages.own', () =>
    client.getMessages(chat, { limit: Math.min(limit, MAX_HISTORY), fromUser: 'me' }))

  const out: HistoryMessage[] = []
  for (const m of messages) {
    if (!m) continue
    out.push({
      msg_id: m.id,
      direction: 'out',
      sender_id: m.senderId ? String(m.senderId) : null,
      sender_name: senderNameFromCache(m),
      text: m.message ?? '',
      media_type: mediaTypeOf(m),
      reply_to: m.replyTo?.replyToMsgId ?? null,
      ts: m.date,
    })
  }
  return out.reverse() // chronological
}

export interface PeerState {
  chat_id: string
  unread: number
  /** Highest message id the owner has read in this chat. */
  read_inbox_max_id: number
}

/**
 * Live read state for one chat.
 *
 * The locally tracked counter cannot see the owner opening the chat on their
 * phone. Anything about to speak on their behalf must ask Telegram first, and
 * one dialog lookup is cheap enough to do at that moment only.
 */
export async function getPeerState(client: TelegramClient, chat: string): Promise<PeerState | null> {
  const peer = await throttled('getPeerState.getInputEntity', () => client.getInputEntity(chat))
  const res = await throttled('getPeerState.getPeerDialogs', () =>
    client.invoke(new Api.messages.GetPeerDialogs({
      peers: [new Api.InputDialogPeer({ peer })],
    })))

  const dialog = res.dialogs.find(d => d.className === 'Dialog') as Api.Dialog | undefined
  if (!dialog) return null
  return {
    chat_id: String(chat),
    unread: dialog.unreadCount ?? 0,
    read_inbox_max_id: dialog.readInboxMaxId ?? 0,
  }
}
