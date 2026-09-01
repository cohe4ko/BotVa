/**
 * Telegram Observer — storage.
 *
 * Project-level SQLite (store/telegram.db), shared by the daemon and the admin UI.
 * Phase 1-2 scope: raw message log, chat registry, read cursor, outbox audit.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { TG_DB_PATH, TG_STORE_DIR } from './paths.js'

let db: DatabaseSync | undefined

export type ChatMode = 'ignore' | 'log-only' | 'facts-only' | 'full'
export type ChatKind = 'user' | 'bot' | 'group' | 'supergroup' | 'channel'
export type Direction = 'in' | 'out'

export interface TgChat {
  chat_id: string
  title: string
  username: string | null
  kind: ChatKind
  mode: ChatMode
  can_send: number
  unread: number
  last_msg_ts: number | null
  created_at: number
  updated_at: number
}

export interface TgMessage {
  id: number
  chat_id: string
  msg_id: number
  direction: Direction
  sender_id: string | null
  sender_name: string | null
  text: string
  media_type: string | null
  reply_to: number | null
  ts: number
  edited_ts: number | null
  deleted_ts: number | null
}

export interface OutboxEntry {
  id: number
  chat_id: string
  kind: string
  text: string
  file_path: string | null
  status: 'sent' | 'failed'
  error: string | null
  requested_by: string
  msg_id: number | null
  created_at: number
}

export function getTgDb(): DatabaseSync {
  if (!db) {
    mkdirSync(TG_STORE_DIR, { recursive: true })
    db = new DatabaseSync(TG_DB_PATH)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA trusted_schema = ON')
    initTgSchema(db)
  }
  return db
}

/** Close the handle — used by tests and by graceful shutdown. */
export function closeTgDb(): void {
  if (db) {
    try { db.close() } catch { /* already closed */ }
    db = undefined
  }
}

function initTgSchema(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS tg_chats (
      chat_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      username TEXT,
      kind TEXT NOT NULL DEFAULT 'user',
      mode TEXT NOT NULL DEFAULT 'log-only' CHECK(mode IN ('ignore','log-only','facts-only','full')),
      can_send INTEGER NOT NULL DEFAULT 0,
      unread INTEGER NOT NULL DEFAULT 0,
      last_msg_ts INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS tg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      msg_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      sender_id TEXT,
      sender_name TEXT,
      text TEXT NOT NULL DEFAULT '',
      media_type TEXT,
      reply_to INTEGER,
      ts INTEGER NOT NULL,
      edited_ts INTEGER,
      deleted_ts INTEGER,
      UNIQUE(chat_id, msg_id)
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_tg_msg_chat_ts ON tg_messages(chat_id, ts DESC)')
  d.exec('CREATE INDEX IF NOT EXISTS idx_tg_msg_ts ON tg_messages(ts DESC)')

  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tg_messages_fts USING fts5(text)
  `)
  // FTS sync on insert; edit/delete are handled manually so the index cannot drift.
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS tg_messages_ai AFTER INSERT ON tg_messages BEGIN
      INSERT INTO tg_messages_fts(rowid, text) VALUES (new.id, new.text);
    END
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS tg_cursor (
      chat_id TEXT PRIMARY KEY,
      last_msg_id INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS tg_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      file_path TEXT,
      status TEXT NOT NULL CHECK(status IN ('sent','failed')),
      error TEXT,
      requested_by TEXT NOT NULL DEFAULT 'unknown',
      msg_id INTEGER,
      created_at INTEGER NOT NULL
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_tg_outbox_created ON tg_outbox(created_at DESC)')
}

const now = (): number => Math.floor(Date.now() / 1000)

// --- Chats ---

/** Insert or refresh chat metadata. Never downgrades a mode the user has chosen. */
export function upsertChat(chat: {
  chat_id: string
  title: string
  username?: string | null
  kind: ChatKind
  defaultMode: ChatMode
}): TgChat {
  const d = getTgDb()
  const ts = now()
  d.prepare(`
    INSERT INTO tg_chats (chat_id, title, username, kind, mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      title = excluded.title,
      username = excluded.username,
      kind = excluded.kind,
      updated_at = excluded.updated_at
  `).run(chat.chat_id, chat.title, chat.username ?? null, chat.kind, chat.defaultMode, ts, ts)
  return getChat(chat.chat_id)!
}

export function getChat(chatId: string): TgChat | null {
  const d = getTgDb()
  return (d.prepare('SELECT * FROM tg_chats WHERE chat_id = ?').get(chatId) as unknown as TgChat) ?? null
}

export function listChats(opts?: { kind?: ChatKind; mode?: ChatMode; limit?: number }): TgChat[] {
  const d = getTgDb()
  const where: string[] = []
  const args: unknown[] = []
  if (opts?.kind) { where.push('kind = ?'); args.push(opts.kind) }
  if (opts?.mode) { where.push('mode = ?'); args.push(opts.mode) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  args.push(opts?.limit ?? 500)
  return d.prepare(
    `SELECT * FROM tg_chats ${clause} ORDER BY last_msg_ts DESC NULLS LAST, updated_at DESC LIMIT ?`
  ).all(...args as never[]) as unknown as TgChat[]
}

export function setChatMode(chatId: string, mode: ChatMode): void {
  getTgDb().prepare('UPDATE tg_chats SET mode = ?, updated_at = ? WHERE chat_id = ?').run(mode, now(), chatId)
}

export function setChatCanSend(chatId: string, canSend: boolean): void {
  getTgDb().prepare('UPDATE tg_chats SET can_send = ?, updated_at = ? WHERE chat_id = ?').run(canSend ? 1 : 0, now(), chatId)
}

export function setChatUnread(chatId: string, unread: number): void {
  getTgDb().prepare('UPDATE tg_chats SET unread = ?, updated_at = ? WHERE chat_id = ?').run(unread, now(), chatId)
}

/** Chats with pending unread messages, most recent first. */
export function listUnreadChats(limit = 50): TgChat[] {
  return getTgDb().prepare(
    'SELECT * FROM tg_chats WHERE unread > 0 ORDER BY last_msg_ts DESC LIMIT ?'
  ).all(limit) as unknown as TgChat[]
}

// --- Messages ---

/** Idempotent: a re-delivered message (daemon restart, catch-up) is ignored. */
export function insertMessage(m: {
  chat_id: string
  msg_id: number
  direction: Direction
  sender_id?: string | null
  sender_name?: string | null
  text?: string
  media_type?: string | null
  reply_to?: number | null
  ts: number
}): boolean {
  const d = getTgDb()
  const res = d.prepare(`
    INSERT OR IGNORE INTO tg_messages
      (chat_id, msg_id, direction, sender_id, sender_name, text, media_type, reply_to, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.chat_id, m.msg_id, m.direction, m.sender_id ?? null, m.sender_name ?? null,
    m.text ?? '', m.media_type ?? null, m.reply_to ?? null, m.ts,
  )
  const inserted = Number(res.changes) > 0
  if (inserted) {
    d.prepare('UPDATE tg_chats SET last_msg_ts = ?, updated_at = ? WHERE chat_id = ?').run(m.ts, now(), m.chat_id)
    bumpCursor(m.chat_id, m.msg_id)
  }
  return inserted
}

export function markEdited(chatId: string, msgId: number, text: string): void {
  const d = getTgDb()
  const row = d.prepare('SELECT id FROM tg_messages WHERE chat_id = ? AND msg_id = ?').get(chatId, msgId) as { id: number } | undefined
  if (!row) return
  d.prepare('UPDATE tg_messages SET text = ?, edited_ts = ? WHERE id = ?').run(text, now(), row.id)
  try {
    d.prepare('DELETE FROM tg_messages_fts WHERE rowid = ?').run(row.id)
    d.prepare('INSERT INTO tg_messages_fts(rowid, text) VALUES (?, ?)').run(row.id, text)
  } catch { /* FTS drift is non-fatal for logging */ }
}

/** Tombstone: keep the fact that a message existed, drop its content. */
export function markDeleted(chatId: string, msgId: number): void {
  const d = getTgDb()
  const row = d.prepare('SELECT id FROM tg_messages WHERE chat_id = ? AND msg_id = ?').get(chatId, msgId) as { id: number } | undefined
  if (!row) return
  d.prepare('UPDATE tg_messages SET deleted_ts = ?, text = ? WHERE id = ?').run(now(), '', row.id)
  try { d.prepare('DELETE FROM tg_messages_fts WHERE rowid = ?').run(row.id) } catch { /* ignore */ }
}

/**
 * Delete by message id alone.
 *
 * Telegram omits the chat for deletions in private chats and small groups, and
 * GramJS does not track where a message lived. Message ids are unique per
 * account outside channels, so the id alone identifies the row.
 */
export function markDeletedByMsgId(msgId: number): string | null {
  const d = getTgDb()
  const row = d.prepare(
    'SELECT id, chat_id FROM tg_messages WHERE msg_id = ? AND deleted_ts IS NULL ORDER BY ts DESC LIMIT 1'
  ).get(msgId) as { id: number; chat_id: string } | undefined
  if (!row) return null
  d.prepare('UPDATE tg_messages SET deleted_ts = ?, text = ? WHERE id = ?').run(now(), '', row.id)
  try { d.prepare('DELETE FROM tg_messages_fts WHERE rowid = ?').run(row.id) } catch { /* ignore */ }
  return row.chat_id
}

export function getMessages(chatId: string, limit = 50, beforeTs?: number): TgMessage[] {
  const d = getTgDb()
  if (beforeTs) {
    return d.prepare(
      'SELECT * FROM tg_messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC, msg_id DESC LIMIT ?'
    ).all(chatId, beforeTs, limit) as unknown as TgMessage[]
  }
  return d.prepare(
    'SELECT * FROM tg_messages WHERE chat_id = ? ORDER BY ts DESC, msg_id DESC LIMIT ?'
  ).all(chatId, limit) as unknown as TgMessage[]
}

export function getRecentMessages(limit = 100, direction?: Direction): TgMessage[] {
  const d = getTgDb()
  if (direction) {
    return d.prepare('SELECT * FROM tg_messages WHERE direction = ? ORDER BY ts DESC LIMIT ?')
      .all(direction, limit) as unknown as TgMessage[]
  }
  return d.prepare('SELECT * FROM tg_messages ORDER BY ts DESC LIMIT ?').all(limit) as unknown as TgMessage[]
}

export function searchMessages(query: string, opts?: { chatId?: string; sinceTs?: number; limit?: number }): TgMessage[] {
  const d = getTgDb()
  const sanitized = query.replace(/["*]/g, ' ').trim()
  if (!sanitized) return []
  const ftsQuery = sanitized.split(/\s+/).map(w => `"${w}"*`).join(' OR ')
  const where: string[] = ['tg_messages_fts MATCH ?']
  const args: unknown[] = [ftsQuery]
  if (opts?.chatId) { where.push('m.chat_id = ?'); args.push(opts.chatId) }
  if (opts?.sinceTs) { where.push('m.ts >= ?'); args.push(opts.sinceTs) }
  args.push(opts?.limit ?? 30)
  return d.prepare(`
    SELECT m.* FROM tg_messages m
    JOIN tg_messages_fts f ON f.rowid = m.id
    WHERE ${where.join(' AND ')}
    ORDER BY m.ts DESC
    LIMIT ?
  `).all(...args as never[]) as unknown as TgMessage[]
}

export function countMessages(): { total: number; incoming: number; outgoing: number; chats: number } {
  const d = getTgDb()
  const row = d.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS incoming,
      SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS outgoing
    FROM tg_messages
  `).get() as { total: number; incoming: number | null; outgoing: number | null }
  const chats = d.prepare('SELECT COUNT(*) AS n FROM tg_chats').get() as { n: number }
  return { total: row.total, incoming: row.incoming ?? 0, outgoing: row.outgoing ?? 0, chats: chats.n }
}

// --- Cursor ---

function bumpCursor(chatId: string, msgId: number): void {
  getTgDb().prepare(`
    INSERT INTO tg_cursor (chat_id, last_msg_id) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET last_msg_id = MAX(last_msg_id, excluded.last_msg_id)
  `).run(chatId, msgId)
}

export function getCursor(chatId: string): number {
  const row = getTgDb().prepare('SELECT last_msg_id FROM tg_cursor WHERE chat_id = ?').get(chatId) as { last_msg_id: number } | undefined
  return row?.last_msg_id ?? 0
}

// --- Outbox ---

export function recordOutbox(e: {
  chat_id: string
  kind: string
  text?: string
  file_path?: string | null
  status: 'sent' | 'failed'
  error?: string | null
  requested_by?: string
  msg_id?: number | null
}): number {
  const res = getTgDb().prepare(`
    INSERT INTO tg_outbox (chat_id, kind, text, file_path, status, error, requested_by, msg_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    e.chat_id, e.kind, e.text ?? '', e.file_path ?? null, e.status,
    e.error ?? null, e.requested_by ?? 'unknown', e.msg_id ?? null, now(),
  )
  return Number((res as unknown as { lastInsertRowid: bigint }).lastInsertRowid)
}

export function listOutbox(limit = 50): OutboxEntry[] {
  return getTgDb().prepare('SELECT * FROM tg_outbox ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as OutboxEntry[]
}

/** Sent messages in the last N seconds — feeds the outgoing rate limit. */
export function countOutboxSince(sinceTs: number): number {
  const row = getTgDb().prepare(
    "SELECT COUNT(*) AS n FROM tg_outbox WHERE status = 'sent' AND created_at >= ?"
  ).get(sinceTs) as { n: number }
  return row.n
}
