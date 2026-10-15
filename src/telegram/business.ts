/**
 * Telegram Business (Chat Automation) as the transport for unattended replies.
 *
 * The owner connects this bot in Settings → Chat Automation and picks which
 * private chats it may answer. From then on Telegram delivers those chats'
 * messages to the bot as `business_message` updates, and the bot can reply
 * with `business_connection_id` — on the owner's behalf, officially, with no
 * userbot behind it.
 *
 * What changes is only *how* a reply is sent. *Whether* and *when* to reply is
 * still decided by telegram/autoreply.ts from the observer's log (silence
 * threshold, unread state, the owner answering first): those rules protect the
 * owner and stay exactly as they are. Proactive messages — the owner's own
 * sends, anything outside the reply window, groups — keep going through the
 * MTProto observer.
 *
 * Which chats are covered is not something the Bot API reports. It is learnt
 * from the traffic: the bot only ever receives business messages from chats
 * the owner selected, and may only reply within 24 hours of the last incoming
 * one. So a chat that sent us a business message recently is both covered and
 * inside the reply window — that is exactly the route test.
 */

import type { DatabaseSync } from 'node:sqlite'
import { getDb } from '../db.js'

/** Telegram allows replies within 24 h of the last incoming message; keep a margin. */
export const REPLY_WINDOW_S = 23 * 3600

export interface BusinessConnectionRow {
  id: string
  user_id: number
  user_chat_id: number
  can_reply: number
  is_enabled: number
  updated_at: number
}

/** The subset of Bot API BusinessConnection this module reads. */
export interface BusinessConnectionUpdate {
  id: string
  user: { id: number }
  user_chat_id: number
  is_enabled: boolean
  rights?: { can_reply?: boolean }
  /** Pre-9.0 shape: a single flag instead of rights. */
  can_reply?: boolean
}

/** The subset of a business Message this module reads. */
export interface BusinessMessageUpdate {
  business_connection_id?: string
  chat: { id: number; type: string }
  from?: { id: number; is_bot?: boolean }
  date: number
}

let ready: DatabaseSync | null = null

function db(): DatabaseSync {
  const d = getDb()
  if (ready === d) return d
  d.exec(`
    CREATE TABLE IF NOT EXISTS business_connections (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      user_chat_id INTEGER NOT NULL,
      can_reply INTEGER NOT NULL,
      is_enabled INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS business_chats (
      chat_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      last_incoming_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, connection_id)
    );
  `)
  ready = d
  return d
}

const nowS = () => Math.floor(Date.now() / 1000)

/** Record a connection, a change of its rights, or its removal. */
export function onBusinessConnection(c: BusinessConnectionUpdate, at = nowS()): void {
  const canReply = c.rights ? !!c.rights.can_reply : !!c.can_reply
  db().prepare(`
    INSERT INTO business_connections (id, user_id, user_chat_id, can_reply, is_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, user_chat_id = excluded.user_chat_id,
      can_reply = excluded.can_reply, is_enabled = excluded.is_enabled, updated_at = excluded.updated_at
  `).run(c.id, c.user.id, c.user_chat_id, canReply ? 1 : 0, c.is_enabled ? 1 : 0, at)
}

export function getConnection(id: string): BusinessConnectionRow | undefined {
  return db().prepare('SELECT * FROM business_connections WHERE id = ?').get(id) as unknown as BusinessConnectionRow | undefined
}

/** The live connection that may reply, if the owner has one. Telegram allows one per account. */
export function activeConnection(): BusinessConnectionRow | undefined {
  return db().prepare('SELECT * FROM business_connections WHERE is_enabled = 1 ORDER BY updated_at DESC LIMIT 1')
    .get() as unknown as BusinessConnectionRow | undefined
}

/**
 * Note a business message. Only messages *to* the owner open the reply window;
 * the owner's own messages in the chat arrive too and are ignored here (the
 * observer already sees them, and they are what pauses the autoreply).
 */
export function onBusinessMessage(m: BusinessMessageUpdate): void {
  if (!m.business_connection_id || m.chat.type !== 'private') return
  const conn = getConnection(m.business_connection_id)
  if (!conn) return
  if (m.from?.id === conn.user_id) return
  db().prepare(`
    INSERT INTO business_chats (chat_id, connection_id, last_incoming_at) VALUES (?, ?, ?)
    ON CONFLICT(chat_id, connection_id) DO UPDATE SET last_incoming_at = MAX(last_incoming_at, excluded.last_incoming_at)
  `).run(String(m.chat.id), conn.id, m.date)
}

/**
 * The business connection to reply through for `chatId`, or null to keep the
 * MTProto route: no live connection, no right to reply, the chat not covered,
 * or the last incoming message outside the reply window.
 */
export function businessRouteFor(chatId: string, at = nowS()): string | null {
  const conn = activeConnection()
  if (!conn || !conn.can_reply) return null
  const row = db().prepare('SELECT last_incoming_at FROM business_chats WHERE chat_id = ? AND connection_id = ?')
    .get(chatId, conn.id) as unknown as { last_incoming_at: number } | undefined
  if (!row || at - row.last_incoming_at > REPLY_WINDOW_S) return null
  return conn.id
}

/** Overview for logs and the admin page. */
export function businessStatus(at = nowS()): { connected: boolean; canReply: boolean; chatsInWindow: number } {
  const conn = activeConnection()
  if (!conn) return { connected: false, canReply: false, chatsInWindow: 0 }
  const r = db().prepare('SELECT COUNT(*) AS n FROM business_chats WHERE connection_id = ? AND last_incoming_at >= ?')
    .get(conn.id, at - REPLY_WINDOW_S) as unknown as { n: number }
  return { connected: true, canReply: !!conn.can_reply, chatsInWindow: Number(r.n) }
}

export function _resetBusinessForTests(): void {
  ready = null
}
