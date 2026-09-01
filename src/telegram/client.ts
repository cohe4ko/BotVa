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
import type { ChatKind, ChatMode } from './db.js'

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
 * Default logging mode for a freshly seen chat.
 *
 * Bots are hard-ignored: BotVa's own bots message the same account, and logging
 * them would feed the observer its own output.
 */
export function defaultModeFor(kind: ChatKind): ChatMode {
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
  const dialogs = await client.getDialogs({ limit })
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
  sender_name: string
  text: string
  media_type: string | null
  ts: number
}

export async function getHistory(
  client: TelegramClient,
  chat: string,
  limit = 30,
): Promise<HistoryMessage[]> {
  const messages = await client.getMessages(chat, { limit })
  const out: HistoryMessage[] = []
  for (const m of messages) {
    if (!m) continue
    let senderName = ''
    try {
      const sender = await m.getSender()
      senderName = sender ? getDisplayName(sender as never) : ''
    } catch { /* sender may be unavailable for channel posts */ }
    out.push({
      msg_id: m.id,
      direction: m.out ? 'out' : 'in',
      sender_name: senderName,
      text: m.message ?? '',
      media_type: mediaTypeOf(m),
      ts: m.date,
    })
  }
  return out.reverse() // chronological
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

export async function sendText(client: TelegramClient, chat: string, text: string): Promise<number> {
  const msg = await client.sendMessage(chat, { message: text })
  return msg.id
}

export async function sendFile(
  client: TelegramClient,
  chat: string,
  path: string,
  caption?: string,
  asDocument = false,
): Promise<number> {
  const msg = await client.sendFile(chat, {
    file: path,
    caption,
    forceDocument: asDocument,
  })
  return msg.id
}

export async function resolveChat(client: TelegramClient, query: string): Promise<ChatInfo | null> {
  try {
    const entity = await client.getEntity(query)
    return classifyEntity(entity)
  } catch {
    return null
  }
}

export async function markRead(client: TelegramClient, chat: string): Promise<void> {
  await client.markAsRead(chat)
}
