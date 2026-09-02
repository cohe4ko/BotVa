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
  /** Bot that answers unattended messages here. Empty string = nobody. */
  auto_reply_bot: string
  /** Silence required before the bot steps in, seconds. */
  auto_reply_after_s: number
  /** 1 = only act while the chat is genuinely unread in Telegram. */
  auto_reply_require_unread: number
  /** Highest incoming msg_id already answered, so one message is answered once. */
  auto_reply_last_msg_id: number
  auto_reply_last_ts: number | null
  /** Free-form instruction for how to answer in this chat. */
  auto_reply_prompt: string
  /**
   * Highest msg_id the chat's agent session has already been shown.
   *
   * Distinct from `auto_reply_last_msg_id`, which tracks what has been *answered*.
   * The owner may exchange fifty messages by hand between two unattended
   * replies: those were never answered by the bot, but the session still has to
   * see them or it resumes a conversation it no longer follows.
   */
  auto_reply_ctx_msg_id: number
  /**
   * 1 = act only on messages that concern the owner (an @mention or a reply to
   * him). Defaults on for groups, where every other message is between other
   * people, and off for private chats, where everything is addressed to him.
   */
  auto_reply_mention_only: number
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
  status: 'sent' | 'failed' | 'skipped'
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
      owner_id TEXT NOT NULL DEFAULT 'legacy',
      UNIQUE(owner_id, chat_id, msg_id)
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
      owner_id TEXT NOT NULL DEFAULT 'legacy',
      chat_id TEXT NOT NULL,
      last_msg_id INTEGER NOT NULL,
      PRIMARY KEY (owner_id, chat_id)
    )
  `)

  d.exec(`
    CREATE TABLE IF NOT EXISTS tg_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      file_path TEXT,
      status TEXT NOT NULL CHECK(status IN ('sent','failed','skipped')),
      error TEXT,
      requested_by TEXT NOT NULL DEFAULT 'unknown',
      msg_id INTEGER,
      created_at INTEGER NOT NULL
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_tg_outbox_created ON tg_outbox(created_at DESC)')

  // Which account produced this data.
  //
  // `direction` is relative to the session owner: the same conversation logged
  // from two accounts yields opposite in/out values under the same chat_id.
  // Rows written before this column existed are marked 'legacy' — they cannot
  // be attributed, and silently folding them into the current account would
  // corrupt the record.
  d.exec(`
    CREATE TABLE IF NOT EXISTS tg_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  try {
    d.exec("ALTER TABLE tg_chats ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'legacy'")
  } catch { /* already exists */ }
  try {
    d.exec("ALTER TABLE tg_messages ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'legacy'")
  } catch { /* already exists */ }
  migrateMessageUniqueness(d)
  d.exec('CREATE INDEX IF NOT EXISTS idx_tg_msg_owner ON tg_messages(owner_id, ts DESC)')

  // Unattended-reply policy, per chat. Off unless a bot is named here.
  for (const ddl of [
    "ALTER TABLE tg_chats ADD COLUMN auto_reply_bot TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE tg_chats ADD COLUMN auto_reply_after_s INTEGER NOT NULL DEFAULT 300',
    'ALTER TABLE tg_chats ADD COLUMN auto_reply_require_unread INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE tg_chats ADD COLUMN auto_reply_last_msg_id INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tg_chats ADD COLUMN auto_reply_last_ts INTEGER',
    "ALTER TABLE tg_chats ADD COLUMN auto_reply_prompt TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE tg_chats ADD COLUMN auto_reply_ctx_msg_id INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tg_chats ADD COLUMN auto_reply_mention_only INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { d.exec(ddl) } catch { /* already exists */ }
  }

  // Lowercased "title + username" for search.
  //
  // SQLite's LOWER() only folds ASCII, so a Cyrillic query would silently match
  // nothing. JS toLowerCase() is Unicode-aware, so the key is computed on write
  // and matched verbatim on read.
  try { d.exec('ALTER TABLE tg_chats ADD COLUMN search_key TEXT NOT NULL DEFAULT \'\'') } catch { /* already exists */ }
  d.exec('CREATE INDEX IF NOT EXISTS idx_tg_chats_recent ON tg_chats(last_msg_ts DESC)')
  backfillSearchKeys(d)
}

/**
 * Widen the message uniqueness key to include the owner.
 *
 * The original constraint was UNIQUE(chat_id, msg_id). After an account switch
 * the same pair legitimately occurs twice — chat 777000 message 5 exists for
 * every account — and `INSERT OR IGNORE` would drop the newer row without a
 * word. SQLite cannot alter a constraint in place, so the table is rebuilt.
 * Row ids are copied verbatim: the FTS index addresses them as rowids.
 */
function migrateMessageUniqueness(d: DatabaseSync): void {
  const row = d.prepare('SELECT value FROM tg_meta WHERE key = ?').get('schema_v') as { value: string } | undefined
  if (row?.value === '3') return

  const hasOwnerKey = (d.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tg_messages' AND sql LIKE '%UNIQUE(owner_id%'"
  ).get() as { n: number }).n > 0

  if (!hasOwnerKey) {
    d.exec('DROP TRIGGER IF EXISTS tg_messages_ai')
    d.exec(`
      CREATE TABLE tg_messages_v2 (
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
        owner_id TEXT NOT NULL DEFAULT 'legacy',
        UNIQUE(owner_id, chat_id, msg_id)
      )
    `)
    d.exec(`
      INSERT INTO tg_messages_v2
        (id, chat_id, msg_id, direction, sender_id, sender_name, text, media_type,
         reply_to, ts, edited_ts, deleted_ts, owner_id)
      SELECT id, chat_id, msg_id, direction, sender_id, sender_name, text, media_type,
             reply_to, ts, edited_ts, deleted_ts, owner_id
      FROM tg_messages
    `)
    d.exec('DROP TABLE tg_messages')
    d.exec('ALTER TABLE tg_messages_v2 RENAME TO tg_messages')
    d.exec('CREATE INDEX IF NOT EXISTS idx_tg_msg_chat_ts ON tg_messages(chat_id, ts DESC)')
    d.exec('CREATE INDEX IF NOT EXISTS idx_tg_msg_ts ON tg_messages(ts DESC)')
    d.exec(`
      CREATE TRIGGER IF NOT EXISTS tg_messages_ai AFTER INSERT ON tg_messages BEGIN
        INSERT INTO tg_messages_fts(rowid, text) VALUES (new.id, new.text);
      END
    `)
  }

  // The read cursor is owner-relative for the same reason: msg_id sequences are
  // per-chat, and one account's position says nothing about another's.
  const cursorHasOwner = (d.prepare(
    "SELECT COUNT(*) AS n FROM pragma_table_info('tg_cursor') WHERE name = 'owner_id'"
  ).get() as { n: number }).n > 0

  if (!cursorHasOwner) {
    d.exec(`
      CREATE TABLE tg_cursor_v2 (
        owner_id TEXT NOT NULL DEFAULT 'legacy',
        chat_id TEXT NOT NULL,
        last_msg_id INTEGER NOT NULL,
        PRIMARY KEY (owner_id, chat_id)
      )
    `)
    d.exec("INSERT INTO tg_cursor_v2 (owner_id, chat_id, last_msg_id) SELECT 'legacy', chat_id, last_msg_id FROM tg_cursor")
    d.exec('DROP TABLE tg_cursor')
    d.exec('ALTER TABLE tg_cursor_v2 RENAME TO tg_cursor')
  }

  // A bot deciding to stay silent is an action worth showing, so the outbox
  // records it too — but the original CHECK only allowed sent/failed, and a
  // decline is neither.
  const outboxSql = (d.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tg_outbox'"
  ).get() as { sql: string } | undefined)?.sql ?? ''

  if (!outboxSql.includes("'skipped'")) {
    d.exec(`
      CREATE TABLE tg_outbox_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        file_path TEXT,
        status TEXT NOT NULL CHECK(status IN ('sent','failed','skipped')),
        error TEXT,
        requested_by TEXT NOT NULL DEFAULT 'unknown',
        msg_id INTEGER,
        created_at INTEGER NOT NULL
      )
    `)
    d.exec(`
      INSERT INTO tg_outbox_v2
        (id, chat_id, kind, text, file_path, status, error, requested_by, msg_id, created_at)
      SELECT id, chat_id, kind, text, file_path, status, error, requested_by, msg_id, created_at
      FROM tg_outbox
    `)
    d.exec('DROP TABLE tg_outbox')
    d.exec('ALTER TABLE tg_outbox_v2 RENAME TO tg_outbox')
    d.exec('CREATE INDEX IF NOT EXISTS idx_tg_outbox_created ON tg_outbox(created_at DESC)')
  }

  d.prepare(
    'INSERT INTO tg_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('schema_v', '3')
}

function searchKeyFor(title: string, username?: string | null): string {
  return `${title} ${username ?? ''}`.toLowerCase().trim()
}

/** One-time fill for rows written before search_key existed. */
function backfillSearchKeys(d: DatabaseSync): void {
  const rows = d.prepare("SELECT chat_id, title, username FROM tg_chats WHERE search_key = ''")
    .all() as { chat_id: string; title: string; username: string | null }[]
  if (rows.length === 0) return
  const stmt = d.prepare('UPDATE tg_chats SET search_key = ? WHERE chat_id = ?')
  for (const row of rows) stmt.run(searchKeyFor(row.title, row.username), row.chat_id)
}

const now = (): number => Math.floor(Date.now() / 1000)

// --- Session owner ---

const OWNER_KEY = 'owner_id'
export const LEGACY_OWNER = 'legacy'

let ownerCache: string | null = null

export function getOwnerId(): string {
  if (ownerCache !== null) return ownerCache
  const row = getTgDb().prepare('SELECT value FROM tg_meta WHERE key = ?').get(OWNER_KEY) as { value: string } | undefined
  // Before the daemon has ever logged in, everything on disk is legacy data —
  // reading as LEGACY_OWNER keeps an existing installation visible instead of
  // showing an empty database until the first successful connection.
  ownerCache = row?.value ?? LEGACY_OWNER
  return ownerCache
}

/**
 * Record which account the daemon is logged in as.
 * Returns the previous owner so the caller can warn about a switch.
 */
export function setOwnerId(id: string): { previous: string; changed: boolean } {
  const previous = getOwnerId()
  if (previous !== id) {
    getTgDb().prepare(
      'INSERT INTO tg_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(OWNER_KEY, id)
    ownerCache = id
  }
  return { previous, changed: previous !== LEGACY_OWNER && previous !== id }
}

const OWNER_USERNAME_KEY = 'owner_username'

/**
 * The owner's @username, as the only reliable way to spot a mention.
 *
 * Group messages arrive with entities the log does not keep, so a mention is
 * detected from the text. A display name would match far too much — plenty of
 * sentences contain someone's first name — while "@handle" is unambiguous.
 */
export function getOwnerUsername(): string {
  const row = getTgDb().prepare('SELECT value FROM tg_meta WHERE key = ?').get(OWNER_USERNAME_KEY) as { value: string } | undefined
  return row?.value ?? ''
}

export function setOwnerUsername(username: string): void {
  getTgDb().prepare(
    'INSERT INTO tg_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(OWNER_USERNAME_KEY, username)
}

/** Rows that belong to no known account — from before owner tracking, or another login. */
export function countForeignRows(): { chats: number; messages: number } {
  const d = getTgDb()
  const owner = getOwnerId()
  const chats = d.prepare('SELECT COUNT(*) AS n FROM tg_chats WHERE owner_id != ?').get(owner) as { n: number }
  const messages = d.prepare('SELECT COUNT(*) AS n FROM tg_messages WHERE owner_id != ?').get(owner) as { n: number }
  return { chats: chats.n, messages: messages.n }
}

/** Remove everything not belonging to the current account. Irreversible. */
export function purgeForeignRows(): { chats: number; messages: number } {
  const d = getTgDb()
  const owner = getOwnerId()
  const before = countForeignRows()
  d.exec('BEGIN')
  try {
    d.prepare('DELETE FROM tg_messages_fts WHERE rowid IN (SELECT id FROM tg_messages WHERE owner_id != ?)').run(owner)
    d.prepare('DELETE FROM tg_messages WHERE owner_id != ?').run(owner)
    d.prepare('DELETE FROM tg_cursor WHERE owner_id != ?').run(owner)
    d.prepare('DELETE FROM tg_chats WHERE owner_id != ?').run(owner)
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
  return before
}

/** Test seam: drop the cached owner so a fresh read hits the table. */
export function resetOwnerCache(): void {
  ownerCache = null
}

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
    INSERT INTO tg_chats (chat_id, title, username, kind, mode, search_key, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      title = excluded.title,
      username = excluded.username,
      kind = excluded.kind,
      search_key = excluded.search_key,
      owner_id = excluded.owner_id,
      updated_at = excluded.updated_at
  `).run(
    chat.chat_id, chat.title, chat.username ?? null, chat.kind, chat.defaultMode,
    searchKeyFor(chat.title, chat.username), getOwnerId(), ts, ts,
  )
  return getChat(chat.chat_id)!
}

export function getChat(chatId: string): TgChat | null {
  const d = getTgDb()
  return (d.prepare('SELECT * FROM tg_chats WHERE chat_id = ?').get(chatId) as unknown as TgChat) ?? null
}

export interface ListChatsOptions {
  kind?: ChatKind
  mode?: ChatMode
  /** Exclude chats whose last activity is older than this unix timestamp. */
  activeSince?: number
  /** Case-insensitive substring match on title or username. */
  search?: string
  /** Only chats with pending unread messages. */
  unreadOnly?: boolean
  limit?: number
  offset?: number
}

/**
 * Build the shared WHERE clause for chat listing and counting.
 * Kept in one place so a filter can never apply to the page but not the count.
 */
function chatFilter(opts: ListChatsOptions = {}): { clause: string; args: unknown[] } {
  // Always scoped to the logged-in account: rows from a previous login describe
  // the same chats from the opposite side.
  const where: string[] = ['owner_id = ?']
  const args: unknown[] = [getOwnerId()]
  if (opts.kind) { where.push('kind = ?'); args.push(opts.kind) }
  if (opts.mode) { where.push('mode = ?'); args.push(opts.mode) }
  if (opts.unreadOnly) where.push('unread > 0')
  if (opts.activeSince) {
    where.push('(last_msg_ts IS NOT NULL AND last_msg_ts >= ?)')
    args.push(opts.activeSince)
  }
  if (opts.search?.trim()) {
    const term = opts.search.trim()
    where.push('(search_key LIKE ? ESCAPE \'\\\' OR chat_id = ?)')
    // Escape LIKE wildcards so a literal % or _ in a chat title still matches.
    const escaped = term.toLowerCase().replace(/[\\%_]/g, m => `\\${m}`)
    args.push(`%${escaped}%`, term)
  }
  return { clause: `WHERE ${where.join(' AND ')}`, args }
}

/**
 * Chats ordered by recency.
 *
 * An account can hold thousands of dialogs, so every caller must page. The
 * default limit is deliberately small — an unbounded read here is what turns a
 * page render or a catch-up pass into a flood of work.
 */
export function listChats(opts: ListChatsOptions = {}): TgChat[] {
  const { clause, args } = chatFilter(opts)
  args.push(opts.limit ?? 50, opts.offset ?? 0)
  return getTgDb().prepare(
    `SELECT * FROM tg_chats ${clause}
     ORDER BY last_msg_ts DESC NULLS LAST, updated_at DESC
     LIMIT ? OFFSET ?`
  ).all(...args as never[]) as unknown as TgChat[]
}

export function countChats(opts: ListChatsOptions = {}): number {
  const { clause, args } = chatFilter(opts)
  const row = getTgDb().prepare(`SELECT COUNT(*) AS n FROM tg_chats ${clause}`)
    .get(...args as never[]) as { n: number }
  return row.n
}

export function setChatMode(chatId: string, mode: ChatMode): void {
  getTgDb().prepare('UPDATE tg_chats SET mode = ?, updated_at = ? WHERE chat_id = ?').run(mode, now(), chatId)
}

/**
 * Keep the unread counter live between dialog syncs.
 *
 * `syncUnread` corrects it from Telegram every quarter hour, which is far too
 * coarse for a policy that reacts in minutes. Counting locally costs nothing and
 * no API call: an incoming message adds one, anything the owner sends clears it.
 */
export function bumpUnread(chatId: string, delta: number): void {
  getTgDb().prepare(
    'UPDATE tg_chats SET unread = MAX(0, unread + ?), updated_at = ? WHERE chat_id = ?'
  ).run(delta, now(), chatId)
}

// --- Unattended replies ---

export interface AutoReplyPolicy {
  /** Bot name, or '' to switch the chat off. */
  bot: string
  afterSeconds: number
  requireUnread: boolean
  /** Act only on an @mention or a reply to the owner. */
  mentionOnly: boolean
}

/**
 * Assign — or clear — the bot that answers when the owner stays silent.
 *
 * Turning the policy on resets the answered-up-to marker to the newest logged
 * message, so switching a chat on does not fire an answer to a conversation
 * that went quiet last week.
 */
export function setAutoReply(chatId: string, policy: AutoReplyPolicy): void {
  const d = getTgDb()
  const current = getChat(chatId)
  if (!current) return

  // Only a chat going from off to on rewinds the marker. Adjusting the delay or
  // the unread guard on a live chat must not discard what has been answered.
  const turningOn = !current.auto_reply_bot && !!policy.bot
  const latest = turningOn
    ? (d.prepare('SELECT MAX(msg_id) AS m FROM tg_messages WHERE chat_id = ? AND owner_id = ?')
        .get(chatId, getOwnerId()) as { m: number | null }).m ?? 0
    : current.auto_reply_last_msg_id

  d.prepare(`
    UPDATE tg_chats SET
      auto_reply_bot = ?,
      auto_reply_after_s = ?,
      auto_reply_require_unread = ?,
      auto_reply_mention_only = ?,
      auto_reply_last_msg_id = ?,
      updated_at = ?
    WHERE chat_id = ?
  `).run(
    policy.bot,
    Math.max(30, Math.floor(policy.afterSeconds)),
    policy.requireUnread ? 1 : 0,
    policy.mentionOnly ? 1 : 0,
    policy.bot ? latest : 0,
    now(),
    chatId,
  )
}

/** Per-chat instruction: how the bot should sound and what it may say here. */
export function setAutoReplyPrompt(chatId: string, prompt: string): void {
  getTgDb().prepare('UPDATE tg_chats SET auto_reply_prompt = ?, updated_at = ? WHERE chat_id = ?')
    .run(prompt.trim(), now(), chatId)
}

/**
 * Recent messages the owner actually wrote, as raw material for imitation.
 *
 * Describing someone's voice never works as well as showing it. These are real
 * sentences from the archive: short ones are dropped (they carry no style) and
 * so are repeats.
 */
export function getOwnerStyleSamples(limit = 40, chatId?: string, maxChars = 300): string[] {
  const d = getTgDb()
  const args: unknown[] = [getOwnerId()]
  let scope = ''
  if (chatId) { scope = 'AND chat_id = ? '; args.push(chatId) }
  args.push(limit * 4)

  const rows = d.prepare(`
    SELECT text FROM tg_messages
    WHERE owner_id = ? AND direction = 'out' ${scope}
      AND deleted_ts IS NULL AND LENGTH(text) >= ${MIN_SAMPLE_CHARS}
    ORDER BY ts DESC LIMIT ?
  `).all(...args as never[]) as { text: string }[]

  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    const text = r.text.trim()
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    // Long messages are trimmed, never dropped. A three-paragraph reply is as
    // much a part of how someone writes as a one-liner, and the opening of it
    // carries the voice; discarding it would bias the sample towards short
    // notes and quietly teach the wrong rhythm.
    out.push(text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Shortest message worth sampling.
 *
 * "ок" and "+" carry no manner. A few words already do — and in a group short
 * replies are most of what a person writes, so the floor stays low.
 */
const MIN_SAMPLE_CHARS = 6

/**
 * Treat everything up to `msgId` as handled, without starting a cooldown.
 *
 * Used after back-filling a chat's archive. The turn-on rewind sets the marker
 * from what is stored at that moment, so a chat enabled with an empty log gets
 * a marker of zero — and history fetched a second later would then look like a
 * pile of unanswered messages. Re-baselining closes that window.
 */
export function baselineAutoReply(chatId: string, msgId: number): void {
  getTgDb().prepare(
    'UPDATE tg_chats SET auto_reply_last_msg_id = MAX(auto_reply_last_msg_id, ?), updated_at = ? WHERE chat_id = ?'
  ).run(msgId, now(), chatId)
}

/** Record that a message has been answered, so it is never answered twice. */
export function markAutoReplied(chatId: string, msgId: number, ts = now()): void {
  getTgDb().prepare(`
    UPDATE tg_chats SET
      auto_reply_last_msg_id = MAX(auto_reply_last_msg_id, ?),
      auto_reply_last_ts = ?,
      updated_at = ?
    WHERE chat_id = ?
  `).run(msgId, ts, now(), chatId)
}

/** Remember how far the chat's agent session has been brought up to date. */
export function setAutoReplyContext(chatId: string, msgId: number): void {
  getTgDb().prepare(
    'UPDATE tg_chats SET auto_reply_ctx_msg_id = MAX(auto_reply_ctx_msg_id, ?), updated_at = ? WHERE chat_id = ?'
  ).run(msgId, now(), chatId)
}

/** Start the session's context afresh — used when a chat is primed again. */
export function resetAutoReplyContext(chatId: string, msgId: number): void {
  getTgDb().prepare('UPDATE tg_chats SET auto_reply_ctx_msg_id = ?, updated_at = ? WHERE chat_id = ?')
    .run(msgId, now(), chatId)
}

/**
 * Everything in a chat newer than a given message, newest first.
 *
 * The limit is a safety valve, not a window: callers must compare the result
 * against `countMessagesAfter` to know whether anything was left out, because a
 * silently truncated gap is worse than an acknowledged one.
 */
export function getMessagesAfter(chatId: string, afterMsgId: number, limit = 100): TgMessage[] {
  return getTgDb().prepare(`
    SELECT * FROM tg_messages
    WHERE chat_id = ? AND owner_id = ? AND msg_id > ?
    ORDER BY msg_id DESC LIMIT ?
  `).all(chatId, getOwnerId(), afterMsgId, limit) as unknown as TgMessage[]
}

export function countMessagesAfter(chatId: string, afterMsgId: number): number {
  const row = getTgDb().prepare(
    'SELECT COUNT(*) AS n FROM tg_messages WHERE chat_id = ? AND owner_id = ? AND msg_id > ?'
  ).get(chatId, getOwnerId(), afterMsgId) as { n: number }
  return row.n
}

/** Chats this bot is responsible for, current account only. */
export function listAutoReplyChats(bot: string): TgChat[] {
  return getTgDb().prepare(
    'SELECT * FROM tg_chats WHERE auto_reply_bot = ? AND owner_id = ? ORDER BY last_msg_ts DESC'
  ).all(bot, getOwnerId()) as unknown as TgChat[]
}

/**
 * The newest incoming message that may start an unattended reply.
 *
 * In a private chat any unanswered message qualifies. In a group it must
 * concern the owner — an @mention, or a reply to something he wrote — because a
 * group's newest message is almost always somebody else talking to somebody
 * else, and treating that as an unanswered question would have the bot
 * interrupting a conversation it is not part of.
 */
export function findTriggerMessage(
  chatId: string,
  afterMsgId: number,
  opts: { mentionOnly: boolean; ownerUsername?: string } = { mentionOnly: false },
): TgMessage | null {
  const d = getTgDb()
  const base = `
    FROM tg_messages m
    WHERE m.chat_id = ? AND m.owner_id = ? AND m.deleted_ts IS NULL
      AND m.direction = 'in' AND m.msg_id > ?
  `
  const args: unknown[] = [chatId, getOwnerId(), afterMsgId]

  let mention = ''
  if (opts.mentionOnly) {
    // A reply to the owner counts even without a handle: that is what replying
    // to someone means. Without a known username, replies are all we have.
    const clauses = [`EXISTS (
      SELECT 1 FROM tg_messages r
      WHERE r.chat_id = m.chat_id AND r.owner_id = m.owner_id
        AND r.msg_id = m.reply_to AND r.direction = 'out'
    )`]
    if (opts.ownerUsername) {
      clauses.push("m.text LIKE ? ESCAPE '\\'")
      args.push(`%@${opts.ownerUsername.replace(/[\\%_]/g, c => `\\${c}`)}%`)
    }
    mention = ` AND (${clauses.join(' OR ')})`
  }

  return (d.prepare(`SELECT m.* ${base}${mention} ORDER BY m.msg_id DESC LIMIT 1`)
    .get(...args as never[]) as unknown as TgMessage) ?? null
}

/** Did the owner speak after this message? Then nothing is left unanswered. */
export function hasOwnerReplyAfter(chatId: string, msgId: number): boolean {
  const row = getTgDb().prepare(`
    SELECT 1 AS hit FROM tg_messages
    WHERE chat_id = ? AND owner_id = ? AND direction = 'out'
      AND msg_id > ? AND deleted_ts IS NULL
    LIMIT 1
  `).get(chatId, getOwnerId(), msgId) as { hit: number } | undefined
  return row !== undefined
}

/**
 * When the person who wrote the trigger last said anything.
 *
 * The wait is measured from here rather than from the trigger itself, so a
 * three-line burst is not cut off mid-thought — and, in a busy group, so the
 * bot is not held back forever by other people still talking.
 */
export function lastTsFromSender(chatId: string, senderId: string | null, sinceMsgId: number): number | null {
  if (!senderId) return null
  const row = getTgDb().prepare(`
    SELECT MAX(ts) AS ts FROM tg_messages
    WHERE chat_id = ? AND owner_id = ? AND sender_id = ?
      AND msg_id >= ? AND deleted_ts IS NULL
  `).get(chatId, getOwnerId(), senderId, sinceMsgId) as { ts: number | null }
  return row.ts
}

/** The newest message in a chat, whichever direction. */
export function getLastMessage(chatId: string): TgMessage | null {
  return (getTgDb().prepare(
    'SELECT * FROM tg_messages WHERE chat_id = ? AND owner_id = ? AND deleted_ts IS NULL ORDER BY msg_id DESC LIMIT 1'
  ).get(chatId, getOwnerId()) as unknown as TgMessage) ?? null
}

export function setChatCanSend(chatId: string, canSend: boolean): void {
  getTgDb().prepare('UPDATE tg_chats SET can_send = ?, updated_at = ? WHERE chat_id = ?').run(canSend ? 1 : 0, now(), chatId)
}

/**
 * Record last activity without storing the message itself.
 *
 * Ordering and catch-up eligibility depend on recency, which must be known for
 * chats we deliberately do not log (ignore mode) as well as ones we do.
 * Monotonic: a stale dialog snapshot can never drag a chat backwards.
 */
export function touchChatActivity(chatId: string, ts: number): void {
  getTgDb().prepare(
    'UPDATE tg_chats SET last_msg_ts = MAX(COALESCE(last_msg_ts, 0), ?), updated_at = ? WHERE chat_id = ?'
  ).run(ts, now(), chatId)
}

export function setChatUnread(chatId: string, unread: number): void {
  getTgDb().prepare('UPDATE tg_chats SET unread = ?, updated_at = ? WHERE chat_id = ?').run(unread, now(), chatId)
}

/** Chats with pending unread messages, most recent first. */
export function listUnreadChats(limit = 50): TgChat[] {
  return getTgDb().prepare(
    'SELECT * FROM tg_chats WHERE unread > 0 AND owner_id = ? ORDER BY last_msg_ts DESC LIMIT ?'
  ).all(getOwnerId(), limit) as unknown as TgChat[]
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
      (chat_id, msg_id, direction, sender_id, sender_name, text, media_type, reply_to, ts, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.chat_id, m.msg_id, m.direction, m.sender_id ?? null, m.sender_name ?? null,
    m.text ?? '', m.media_type ?? null, m.reply_to ?? null, m.ts, getOwnerId(),
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
  const row = d.prepare('SELECT id FROM tg_messages WHERE chat_id = ? AND msg_id = ? AND owner_id = ?').get(chatId, msgId, getOwnerId()) as { id: number } | undefined
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
  const row = d.prepare('SELECT id FROM tg_messages WHERE chat_id = ? AND msg_id = ? AND owner_id = ?').get(chatId, msgId, getOwnerId()) as { id: number } | undefined
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
    'SELECT id, chat_id FROM tg_messages WHERE msg_id = ? AND owner_id = ? AND deleted_ts IS NULL ORDER BY ts DESC LIMIT 1'
  ).get(msgId, getOwnerId()) as { id: number; chat_id: string } | undefined
  if (!row) return null
  d.prepare('UPDATE tg_messages SET deleted_ts = ?, text = ? WHERE id = ?').run(now(), '', row.id)
  try { d.prepare('DELETE FROM tg_messages_fts WHERE rowid = ?').run(row.id) } catch { /* ignore */ }
  return row.chat_id
}

export function getMessages(chatId: string, limit = 50, beforeTs?: number): TgMessage[] {
  const d = getTgDb()
  if (beforeTs) {
    return d.prepare(
      'SELECT * FROM tg_messages WHERE chat_id = ? AND owner_id = ? AND ts < ? ORDER BY ts DESC, msg_id DESC LIMIT ?'
    ).all(chatId, getOwnerId(), beforeTs, limit) as unknown as TgMessage[]
  }
  return d.prepare(
    'SELECT * FROM tg_messages WHERE chat_id = ? AND owner_id = ? ORDER BY ts DESC, msg_id DESC LIMIT ?'
  ).all(chatId, getOwnerId(), limit) as unknown as TgMessage[]
}

export function getRecentMessages(limit = 100, direction?: Direction): TgMessage[] {
  const d = getTgDb()
  if (direction) {
    return d.prepare('SELECT * FROM tg_messages WHERE direction = ? AND owner_id = ? ORDER BY ts DESC LIMIT ?')
      .all(direction, getOwnerId(), limit) as unknown as TgMessage[]
  }
  return d.prepare('SELECT * FROM tg_messages WHERE owner_id = ? ORDER BY ts DESC LIMIT ?').all(getOwnerId(), limit) as unknown as TgMessage[]
}

export function searchMessages(query: string, opts?: { chatId?: string; sinceTs?: number; limit?: number }): TgMessage[] {
  const d = getTgDb()
  const sanitized = query.replace(/["*]/g, ' ').trim()
  if (!sanitized) return []
  const ftsQuery = sanitized.split(/\s+/).map(w => `"${w}"*`).join(' OR ')
  const where: string[] = ['tg_messages_fts MATCH ?', 'm.owner_id = ?']
  const args: unknown[] = [ftsQuery, getOwnerId()]
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
    FROM tg_messages WHERE owner_id = ?
  `).get(getOwnerId()) as { total: number; incoming: number | null; outgoing: number | null }
  const chats = d.prepare('SELECT COUNT(*) AS n FROM tg_chats WHERE owner_id = ?').get(getOwnerId()) as { n: number }
  return { total: row.total, incoming: row.incoming ?? 0, outgoing: row.outgoing ?? 0, chats: chats.n }
}

// --- Cursor ---

function bumpCursor(chatId: string, msgId: number): void {
  getTgDb().prepare(`
    INSERT INTO tg_cursor (owner_id, chat_id, last_msg_id) VALUES (?, ?, ?)
    ON CONFLICT(owner_id, chat_id) DO UPDATE SET last_msg_id = MAX(last_msg_id, excluded.last_msg_id)
  `).run(getOwnerId(), chatId, msgId)
}

export function getCursor(chatId: string): number {
  const row = getTgDb().prepare('SELECT last_msg_id FROM tg_cursor WHERE owner_id = ? AND chat_id = ?')
    .get(getOwnerId(), chatId) as { last_msg_id: number } | undefined
  return row?.last_msg_id ?? 0
}

// --- Outbox ---

export function recordOutbox(e: {
  chat_id: string
  kind: string
  text?: string
  file_path?: string | null
  status: 'sent' | 'failed' | 'skipped'
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
