import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'fs'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'
import { imageTokenCost } from './pricing.js'

let db: DatabaseSync

export function getDb(): DatabaseSync {
  if (!db) {
    mkdirSync(STORE_DIR, { recursive: true })
    db = new DatabaseSync(`${STORE_DIR}/botva.db`)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA trusted_schema = ON')
  }
  return db
}

function backfillContentHashes(d: DatabaseSync): void {
  const rows = d.prepare('SELECT id, chat_id, content, topic, sector FROM facts WHERE content_hash IS NULL').all() as Array<{ id: number; chat_id: string; content: string; topic: string; sector: string }>
  if (rows.length === 0) return
  logger.info({ count: rows.length }, 'Backfilling content_hash for existing facts')
  const stmt = d.prepare('UPDATE facts SET content_hash = ? WHERE id = ?')
  const dupeIds: number[] = []
  const seen = new Map<string, number>() // key: chat_id|hash -> first id
  for (const row of rows) {
    const hash = computeFactHash(row.content, row.topic, row.sector)
    const key = `${row.chat_id}|${hash}`
    const existing = seen.get(key)
    if (existing) {
      dupeIds.push(row.id < existing ? row.id : existing)
      if (row.id > existing) seen.set(key, row.id) // keep newer
    } else {
      seen.set(key, row.id)
    }
  }
  d.exec('BEGIN')
  try {
    // Delete older duplicates first
    if (dupeIds.length > 0) {
      const placeholders = dupeIds.map(() => '?').join(',')
      d.prepare(`DELETE FROM facts WHERE id IN (${placeholders})`).run(...dupeIds)
      logger.info({ count: dupeIds.length }, 'Removed duplicate facts during backfill')
    }
    // Set hashes for remaining
    for (const row of rows) {
      if (dupeIds.includes(row.id)) continue
      const hash = computeFactHash(row.content, row.topic, row.sector)
      stmt.run(hash, row.id)
    }
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    logger.error({ err }, 'Content hash backfill failed')
  }
}

export function initDatabase(): void {
  const d = getDb()

  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Scheduler
  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run)
  `)

  // Usage tracking
  d.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at)
  `)

  // Add response_time_ms column (safe for existing DBs)
  try {
    d.exec('ALTER TABLE usage_log ADD COLUMN response_time_ms INTEGER')
  } catch { /* column already exists */ }

  // Chat settings (persistent toggles like /stats)
  d.exec(`
    CREATE TABLE IF NOT EXISTS chat_settings (
      chat_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (chat_id, key)
    )
  `)

  // Audit log
  d.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type)
  `)

  // Imagen (image generation) usage tracking
  d.exec(`
    CREATE TABLE IF NOT EXISTS imagen_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('generate','edit')),
      prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      image_bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_imagen_created ON imagen_usage(created_at)
  `)

  // Facts — long-term structured memory (no decay)
  d.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'conversation',
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic','preference')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Migration: add tags column to existing facts tables
  try { d.exec('ALTER TABLE facts ADD COLUMN tags TEXT NOT NULL DEFAULT ""') } catch { /* already exists */ }
  try { d.exec('ALTER TABLE facts ADD COLUMN source TEXT NOT NULL DEFAULT "conversation"') } catch { /* already exists */ }
  // Migration: add embedding column for vector search
  try { d.exec('ALTER TABLE facts ADD COLUMN embedding BLOB') } catch { /* already exists */ }
  // Migration: add 'preference' to sector CHECK constraint (SQLite requires table recreate)
  const tableInfo = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'").get() as { sql: string } | undefined
  if (tableInfo?.sql && !tableInfo.sql.includes("'preference'")) {
    try {
      d.exec('BEGIN')
      d.exec('ALTER TABLE facts RENAME TO facts_old')
      d.exec(`
        CREATE TABLE facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'conversation',
          sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic','preference')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          embedding BLOB
        )
      `)
      d.exec('INSERT INTO facts SELECT * FROM facts_old')
      d.exec('DROP TABLE facts_old')
      d.exec('COMMIT')
    } catch (err) {
      try { d.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw new Error(`Facts table migration failed (adding 'preference' sector): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Migration: add importance, usefulness, access_count columns (savant memory)
  try { d.exec('ALTER TABLE facts ADD COLUMN importance REAL NOT NULL DEFAULT 0.5') } catch { /* already exists */ }
  try { d.exec('ALTER TABLE facts ADD COLUMN usefulness REAL NOT NULL DEFAULT 0.0') } catch { /* already exists */ }
  try { d.exec('ALTER TABLE facts ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }

  // Migration: add content_hash for deduplication (claude-mem pattern)
  try { d.exec('ALTER TABLE facts ADD COLUMN content_hash TEXT') } catch { /* already exists */ }
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_content_hash ON facts(chat_id, content_hash)')
  // Backfill content_hash for existing facts
  backfillContentHashes(d)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_chat_topic ON facts(chat_id, topic)
  `)

  // Fact-to-fact associative links (savant memory graph)
  d.exec(`
    CREATE TABLE IF NOT EXISTS fact_links (
      fact_id_1 INTEGER NOT NULL,
      fact_id_2 INTEGER NOT NULL,
      strength REAL NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (fact_id_1, fact_id_2)
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_fact_links_1 ON fact_links(fact_id_1)')
  d.exec('CREATE INDEX IF NOT EXISTS idx_fact_links_2 ON fact_links(fact_id_2)')

  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      content,
      tags,
      content_rowid='id'
    )
  `)

  // FTS sync: insert via trigger, delete/update handled manually in deleteFact/updateFact
  // (explicit control lets us log errors; delete/update triggers used to crash on the
  // wrong "external content" syntax, which is why manual sync was introduced)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END
  `)
  // Remove buggy triggers from older versions (they used external-content DELETE syntax)
  d.exec('DROP TRIGGER IF EXISTS facts_ad')
  d.exec('DROP TRIGGER IF EXISTS facts_au')

  // Migration v1: repair FTS index after fts-sync bug (pre-2026-04-07)
  //   Before the fix, deleteFact always threw "SQL logic error" (wrong syntax for a
  //   regular FTS5 table) and fell back to a no-op rebuild, leaving orphan rows.
  //   updateFact silently swallowed the same error, so new content was never indexed.
  //   Rebuild the index once from the facts table to guarantee consistency.
  const uv = d.prepare('PRAGMA user_version').get() as { user_version: number }
  if (uv.user_version < 1) {
    d.exec('DELETE FROM facts_fts')
    d.exec('INSERT INTO facts_fts(rowid, content, tags) SELECT id, content, tags FROM facts')
    d.exec('PRAGMA user_version = 1')
  }

  // Reminders (one-shot notifications)
  d.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      text TEXT NOT NULL,
      remind_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent'))
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminders_status_time ON reminders(status, remind_at)
  `)
  // Migration: add fail_count to reminders
  try { d.exec('ALTER TABLE reminders ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }
  // Migration: add run_agent and schedule columns for agent tasks and recurring reminders
  try { d.exec('ALTER TABLE reminders ADD COLUMN run_agent INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }
  try { d.exec('ALTER TABLE reminders ADD COLUMN schedule TEXT') } catch { /* already exists */ }

  // Saved sessions — multiple sessions per chat for switching
  d.exec(`
    CREATE TABLE IF NOT EXISTS saved_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_saved_sessions_chat ON saved_sessions(chat_id, updated_at DESC)
  `)

  // Consolidated sessions tracking (prevent re-consolidation)
  d.exec(`
    CREATE TABLE IF NOT EXISTS consolidated_sessions (
      session_id TEXT PRIMARY KEY,
      file_size INTEGER NOT NULL,
      consolidated_at INTEGER NOT NULL
    )
  `)

  // Mid-session fact extraction tracking (proactive consolidation before context overflow)
  d.exec(`
    CREATE TABLE IF NOT EXISTS mid_session_extractions (
      session_id TEXT PRIMARY KEY,
      file_offset INTEGER NOT NULL,
      extracted_at INTEGER NOT NULL
    )
  `)

  logger.info('Database initialized')
}

// --- Mid-session extraction tracking ---

export function getMidSessionOffset(sessionId: string): number {
  const row = getDb().prepare(
    'SELECT file_offset FROM mid_session_extractions WHERE session_id = ?'
  ).get(sessionId) as { file_offset: number } | undefined
  return row?.file_offset ?? 0
}

export function setMidSessionOffset(sessionId: string, offset: number): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO mid_session_extractions (session_id, file_offset, extracted_at) VALUES (?, ?, ?)'
  ).run(sessionId, offset, Math.floor(Date.now() / 1000))
}

// --- Sessions ---

export function getSession(chatId: string): string | undefined {
  const stmt = getDb().prepare('SELECT session_id FROM sessions WHERE chat_id = ?')
  const row = stmt.get(chatId) as unknown as { session_id: string } | undefined
  return row?.session_id
}

export function setSession(chatId: string, sessionId: string): void {
  getDb().prepare(
    'INSERT INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at'
  ).run(chatId, sessionId, Math.floor(Date.now() / 1000))
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// --- Session Consolidation Tracking ---

export function isSessionConsolidated(sessionId: string, currentSize: number): boolean {
  const row = getDb().prepare(
    'SELECT file_size FROM consolidated_sessions WHERE session_id = ?'
  ).get(sessionId) as { file_size: number } | undefined
  if (!row) return false
  return Math.abs(row.file_size - currentSize) < 200
}

export function markSessionConsolidated(sessionId: string, fileSize: number): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO consolidated_sessions (session_id, file_size, consolidated_at) VALUES (?, ?, ?)'
  ).run(sessionId, fileSize, Math.floor(Date.now() / 1000))
}

// --- Saved Sessions (multi-session support) ---

export interface SavedSession {
  id: number
  chat_id: string
  session_id: string
  name: string
  created_at: number
  updated_at: number
}

const MAX_SAVED_SESSIONS = 20

export function saveSession(chatId: string, sessionId: string, name: string): void {
  const now = Math.floor(Date.now() / 1000)
  const d = getDb()
  // Upsert by chat_id + name (overwrite if same name exists)
  d.prepare(
    'DELETE FROM saved_sessions WHERE chat_id = ? AND name = ?'
  ).run(chatId, name)
  d.prepare(
    'INSERT INTO saved_sessions (chat_id, session_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, sessionId, name, now, now)
  // Trim to max
  d.prepare(
    'DELETE FROM saved_sessions WHERE chat_id = ? AND id NOT IN (SELECT id FROM saved_sessions WHERE chat_id = ? ORDER BY updated_at DESC LIMIT ?)'
  ).run(chatId, chatId, MAX_SAVED_SESSIONS)
}

export function getSavedSessions(chatId: string): SavedSession[] {
  return getDb().prepare(
    'SELECT * FROM saved_sessions WHERE chat_id = ? ORDER BY updated_at DESC LIMIT ?'
  ).all(chatId, MAX_SAVED_SESSIONS) as unknown as SavedSession[]
}

export function getSavedSession(id: number): SavedSession | undefined {
  return getDb().prepare(
    'SELECT * FROM saved_sessions WHERE id = ?'
  ).get(id) as unknown as SavedSession | undefined
}

export function deleteSavedSession(id: number): void {
  getDb().prepare('DELETE FROM saved_sessions WHERE id = ?').run(id)
}

// --- Facts (long-term structured memory, no decay) ---

export type FactSector = 'semantic' | 'episodic' | 'preference'

export interface Fact {
  id: number
  chat_id: string
  topic: string
  content: string
  tags: string
  source: string
  sector: FactSector
  importance: number
  usefulness: number
  access_count: number
  created_at: number
  updated_at: number
}

export interface FactInput {
  content: string
  topic: string
  tags: string
  sector: FactSector
  importance?: number
}

export function computeFactHash(content: string, topic: string, sector: string): string {
  const normalized = `${content.toLowerCase().trim().replace(/\s+/g, ' ')}|${topic}|${sector}`
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export function insertFact(chatId: string, content: string, topic: string, sector: FactSector, tags = '', source = 'conversation', importance = 0.5): number {
  const now = Math.floor(Date.now() / 1000)
  const hash = computeFactHash(content, topic, sector)
  try {
    const result = getDb().prepare(
      'INSERT INTO facts (chat_id, topic, content, tags, source, sector, importance, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(chatId, topic, content, tags, source, sector, importance, hash, now, now)
    return Number((result as unknown as { lastInsertRowid: bigint }).lastInsertRowid)
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) return -1
    throw err
  }
}

export function insertFactsBatch(chatId: string, facts: FactInput[], source = 'conversation'): number[] {
  const now = Math.floor(Date.now() / 1000)
  const d = getDb()
  const stmt = d.prepare(
    'INSERT INTO facts (chat_id, topic, content, tags, source, sector, importance, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const ids: number[] = []
  d.exec('BEGIN')
  try {
    for (const f of facts) {
      const hash = computeFactHash(f.content, f.topic, f.sector)
      try {
        const result = stmt.run(chatId, f.topic, f.content, f.tags, source, f.sector, f.importance ?? 0.5, hash, now, now)
        ids.push(Number((result as unknown as { lastInsertRowid: bigint }).lastInsertRowid))
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
          ids.push(-1) // duplicate
        } else {
          throw err
        }
      }
    }
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
  return ids
}

export function updateFact(id: number, chatId: string, content: string): boolean {
  const d = getDb()
  const now = Math.floor(Date.now() / 1000)
  // Manual FTS sync: drop old row so the reindex below can insert fresh content
  try {
    d.prepare('DELETE FROM facts_fts WHERE rowid = ?').run(id)
  } catch { /* FTS may be out of sync */ }
  // Recompute content_hash for deduplication
  const existing = d.prepare('SELECT topic, sector FROM facts WHERE id = ?').get(id) as { topic: string; sector: string } | undefined
  const hash = existing ? computeFactHash(content, existing.topic, existing.sector) : null
  const result = hash
    ? d.prepare('UPDATE facts SET content = ?, content_hash = ?, updated_at = ? WHERE id = ? AND chat_id = ?').run(content, hash, now, id, chatId)
    : d.prepare('UPDATE facts SET content = ?, updated_at = ? WHERE id = ? AND chat_id = ?').run(content, now, id, chatId)
  if ((result as unknown as { changes: number }).changes > 0) {
    try {
      const updated = d.prepare('SELECT content, tags FROM facts WHERE id = ?').get(id) as { content: string; tags: string }
      d.prepare('INSERT INTO facts_fts(rowid, content, tags) VALUES(?, ?, ?)').run(id, updated.content, updated.tags)
    } catch { /* ignore */ }
  }
  return (result as unknown as { changes: number }).changes > 0
}

export function deleteFact(id: number, chatId: string): boolean {
  const d = getDb()
  // Manual FTS sync: plain DELETE works because facts_fts is a regular FTS5 table
  try {
    d.prepare('DELETE FROM facts_fts WHERE rowid = ?').run(id)
  } catch (err) {
    logger.error({ err, factId: id }, 'FTS delete failed')
  }
  const result = d.prepare("DELETE FROM facts WHERE id = ? AND chat_id IN (?, 'admin')").run(id, chatId)
  return (result as unknown as { changes: number }).changes > 0
}

export function searchFacts(chatId: string, query: string, limit = 10, topic?: string, extDb?: DatabaseSync): Fact[] {
  const sanitized = query.replace(/[^\w\s\u0400-\u04FF]/g, '').trim()
  if (!sanitized) return []

  const d = extDb ?? getDb()
  const ftsQuery = sanitized.split(/\s+/).map(w => `"${w}"*`).join(' OR ')
  try {
    if (topic) {
      return d.prepare(`
        SELECT f.* FROM facts f
        JOIN facts_fts ff ON ff.rowid = f.id
        WHERE facts_fts MATCH ? AND f.chat_id IN (?, 'admin') AND f.topic = ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, chatId, topic, limit) as unknown as Fact[]
    }
    return d.prepare(`
      SELECT f.* FROM facts f
      JOIN facts_fts ff ON ff.rowid = f.id
      WHERE facts_fts MATCH ? AND f.chat_id IN (?, 'admin')
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, chatId, limit) as unknown as Fact[]
  } catch {
    return []
  }
}

export function getFactsByTopic(chatId: string, topic: string, limit = 50): Fact[] {
  return getDb().prepare(
    "SELECT * FROM facts WHERE chat_id IN (?, 'admin') AND topic = ? ORDER BY created_at DESC LIMIT ?"
  ).all(chatId, topic, limit) as unknown as Fact[]
}

export function getFactTopics(chatId: string): { topic: string; count: number; latest: number }[] {
  return getDb().prepare(`
    SELECT topic, COUNT(*) AS count, MAX(updated_at) AS latest
    FROM facts
    WHERE chat_id = ?
    GROUP BY topic
    ORDER BY latest DESC
  `).all(chatId) as unknown as { topic: string; count: number; latest: number }[]
}

export function getAllFacts(chatId: string, limit = 50): Fact[] {
  return getDb().prepare(
    'SELECT * FROM facts WHERE chat_id = ? ORDER BY updated_at DESC LIMIT ?'
  ).all(chatId, limit) as unknown as Fact[]
}

export function getFactsBySector(chatId: string, sector: FactSector, limit = 100): Fact[] {
  return getDb().prepare(
    'SELECT * FROM facts WHERE chat_id = ? AND sector = ? ORDER BY updated_at DESC LIMIT ?'
  ).all(chatId, sector, limit) as unknown as Fact[]
}

// --- Fact importance & usefulness (savant memory) ---

export function boostFactUsefulness(id: number, chatId: string): boolean {
  const result = getDb().prepare(
    "UPDATE facts SET usefulness = usefulness + 0.2, access_count = access_count + 1 WHERE id = ? AND chat_id IN (?, 'admin')"
  ).run(id, chatId)
  return (result as unknown as { changes: number }).changes > 0
}

export function touchFactAccess(ids: number[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  getDb().prepare(
    `UPDATE facts SET access_count = access_count + 1 WHERE id IN (${placeholders})`
  ).run(...ids)
}

export function bumpFactUsefulness(ids: number[], delta = 0.05): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  getDb().prepare(
    `UPDATE facts SET usefulness = MIN(usefulness + ?, 2.0) WHERE id IN (${placeholders})`
  ).run(delta, ...ids)
}

// --- Fact-to-fact links (associative graph) ---

export function insertFactLink(id1: number, id2: number, strength: number): void {
  const now = Math.floor(Date.now() / 1000)
  // Store both directions for efficient lookup
  const d = getDb()
  d.prepare(
    'INSERT OR REPLACE INTO fact_links (fact_id_1, fact_id_2, strength, created_at) VALUES (?, ?, ?, ?)'
  ).run(id1, id2, strength, now)
  d.prepare(
    'INSERT OR REPLACE INTO fact_links (fact_id_1, fact_id_2, strength, created_at) VALUES (?, ?, ?, ?)'
  ).run(id2, id1, strength, now)
}

export function getLinkedFacts(factId: number, chatId: string, limit = 5, extDb?: DatabaseSync): (Fact & { linkStrength: number })[] {
  const d = extDb ?? getDb()
  return d.prepare(`
    SELECT f.*, fl.strength AS linkStrength
    FROM fact_links fl
    JOIN facts f ON f.id = fl.fact_id_2
    WHERE fl.fact_id_1 = ? AND f.chat_id IN (?, 'admin')
    ORDER BY fl.strength DESC
    LIMIT ?
  `).all(factId, chatId, limit) as unknown as (Fact & { linkStrength: number })[]
}

export function getFactById(id: number): Fact | undefined {
  return getDb().prepare('SELECT * FROM facts WHERE id = ?').get(id) as unknown as Fact | undefined
}

// --- Fact embeddings (vector search) ---

export function updateFactEmbedding(id: number, embedding: Float32Array): void {
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
  getDb().prepare('UPDATE facts SET embedding = ? WHERE id = ?').run(buf, id)
}

export function getFactsWithEmbeddings(chatId: string, topic?: string, extDb?: DatabaseSync): (Fact & { embedding: Buffer | null })[] {
  const d = extDb ?? getDb()
  if (topic) {
    return d.prepare(
      "SELECT * FROM facts WHERE chat_id IN (?, 'admin') AND topic = ? AND embedding IS NOT NULL"
    ).all(chatId, topic) as unknown as (Fact & { embedding: Buffer | null })[]
  }
  return d.prepare(
    "SELECT * FROM facts WHERE chat_id IN (?, 'admin') AND embedding IS NOT NULL"
  ).all(chatId) as unknown as (Fact & { embedding: Buffer | null })[]
}

export function getFactsWithoutEmbeddings(chatId: string, limit = 100): { id: number; content: string }[] {
  return getDb().prepare(
    'SELECT id, content FROM facts WHERE chat_id = ? AND embedding IS NULL LIMIT ?'
  ).all(chatId, limit) as unknown as { id: number; content: string }[]
}

// --- Scheduler ---

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
}

export function createTask(id: string, chatId: string, prompt: string, schedule: string, nextRun: number): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, chatId, prompt, schedule, nextRun, 'active', now)
}

export function getDueTasks(): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000)
  return getDb().prepare(
    "SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?"
  ).all(now) as unknown as ScheduledTask[]
}

export function advanceTaskNextRun(id: string, nextRun: number): void {
  getDb().prepare(
    'UPDATE scheduled_tasks SET next_run = ? WHERE id = ?'
  ).run(nextRun, id)
}

export function updateTaskAfterRun(id: string, lastResult: string): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'UPDATE scheduled_tasks SET last_run = ?, last_result = ? WHERE id = ?'
  ).run(now, lastResult, id)
}

export function listTasks(): ScheduledTask[] {
  return getDb().prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as unknown as ScheduledTask[]
}

export function deleteTask(id: string): boolean {
  const result = getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
  return result.changes > 0
}

export function pauseTask(id: string): boolean {
  const result = getDb().prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id)
  return result.changes > 0
}

export function resumeTask(id: string): boolean {
  const result = getDb().prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id)
  return result.changes > 0
}

export function getTask(id: string): ScheduledTask | undefined {
  return getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as unknown as ScheduledTask | undefined
}

// --- Chat settings ---

export function getChatSetting(chatId: string, key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM chat_settings WHERE chat_id = ? AND key = ?').get(chatId, key) as unknown as { value: string } | undefined
  return row?.value
}

export function setChatSetting(chatId: string, key: string, value: string): void {
  getDb().prepare(
    'INSERT INTO chat_settings (chat_id, key, value) VALUES (?, ?, ?) ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value'
  ).run(chatId, key, value)
}

export function deleteChatSetting(chatId: string, key: string): void {
  getDb().prepare('DELETE FROM chat_settings WHERE chat_id = ? AND key = ?').run(chatId, key)
}

// --- Dynamic group allowlist ---

const GLOBAL_SETTINGS_ID = '_global'

export function getApprovedGroups(): string[] {
  const raw = getChatSetting(GLOBAL_SETTINGS_ID, 'allowed_groups')
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

export function addApprovedGroup(groupId: string): void {
  const groups = getApprovedGroups()
  if (!groups.includes(groupId)) {
    groups.push(groupId)
    setChatSetting(GLOBAL_SETTINGS_ID, 'allowed_groups', JSON.stringify(groups))
  }
}

export function removeApprovedGroup(groupId: string): void {
  const groups = getApprovedGroups().filter(id => id !== groupId)
  if (groups.length > 0) {
    setChatSetting(GLOBAL_SETTINGS_ID, 'allowed_groups', JSON.stringify(groups))
  } else {
    deleteChatSetting(GLOBAL_SETTINGS_ID, 'allowed_groups')
  }
}

// --- Imagen usage tracking ---

export function logImagenUsage(
  type: 'generate' | 'edit',
  prompt: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  imageBytes: number
): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO imagen_usage (type, prompt, model, input_tokens, output_tokens, image_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(type, prompt, model, inputTokens, outputTokens, imageBytes, now)
}

export interface ImagenUsageSummary {
  total: number
  generates: number
  edits: number
  inputTokens: number
  outputTokens: number
  totalImageBytes: number
  estimatedCostUSD: number
}

export function getImagenUsageSince(sinceTs: number): ImagenUsageSummary {
  const row = getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN type = 'generate' THEN 1 ELSE 0 END) as generates,
      SUM(CASE WHEN type = 'edit' THEN 1 ELSE 0 END) as edits,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(image_bytes), 0) as totalImageBytes
    FROM imagen_usage WHERE created_at >= ?
  `).get(sinceTs) as unknown as Omit<ImagenUsageSummary, 'estimatedCostUSD'>

  const estimatedCostUSD = imageTokenCost(row.outputTokens ?? 0)
  return { ...row, estimatedCostUSD }
}

// --- Usage tracking ---

export function logUsage(
  chatId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  costUSD: number,
  responseTimeMs?: number
): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO usage_log (chat_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, created_at, response_time_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(chatId, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUSD, now, responseTimeMs ?? null)
}

// --- Audit log ---

export type AuditEventType = 'command' | 'tool_call' | 'error' | 'session_start' | 'session_clear'

export function logAudit(chatId: string | null, eventType: AuditEventType, detail?: string): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO audit_log (chat_id, event_type, detail, created_at) VALUES (?, ?, ?, ?)'
  ).run(chatId, eventType, detail ?? null, now)
}

export interface UsageSummary {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUSD: number
}

export function getUsageSince(sinceTs: number, chatId?: string): UsageSummary {
  const sql = chatId
    ? 'SELECT COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as inputTokens, COALESCE(SUM(output_tokens),0) as outputTokens, COALESCE(SUM(cache_read_tokens),0) as cacheReadTokens, COALESCE(SUM(cache_creation_tokens),0) as cacheCreationTokens, COALESCE(SUM(cost_usd),0) as costUSD FROM usage_log WHERE created_at >= ? AND chat_id = ?'
    : 'SELECT COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as inputTokens, COALESCE(SUM(output_tokens),0) as outputTokens, COALESCE(SUM(cache_read_tokens),0) as cacheReadTokens, COALESCE(SUM(cache_creation_tokens),0) as cacheCreationTokens, COALESCE(SUM(cost_usd),0) as costUSD FROM usage_log WHERE created_at >= ?'

  const args = chatId ? [sinceTs, chatId] : [sinceTs]
  const row = getDb().prepare(sql).get(...args) as unknown as UsageSummary
  return row
}

// --- Reminders (one-shot notifications) ---

export interface Reminder {
  id: number
  chat_id: string
  text: string
  remind_at: number
  created_at: number
  status: 'pending' | 'sent'
  run_agent: number    // 0 = send text, 1 = run agent
  schedule: string | null  // cron expression for recurring, null for one-shot
}

export function insertReminder(chatId: string, text: string, remindAt: number, runAgent = false, schedule: string | null = null): number {
  const now = Math.floor(Date.now() / 1000)
  const result = getDb().prepare(
    'INSERT INTO reminders (chat_id, text, remind_at, created_at, run_agent, schedule) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(chatId, text, remindAt, now, runAgent ? 1 : 0, schedule)
  return Number((result as unknown as { lastInsertRowid: bigint }).lastInsertRowid)
}

export function getDueReminders(): Reminder[] {
  const now = Math.floor(Date.now() / 1000)
  return getDb().prepare(
    "SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= ?"
  ).all(now) as unknown as Reminder[]
}

export function markReminderSent(id: number): void {
  getDb().prepare("UPDATE reminders SET status = 'sent' WHERE id = ?").run(id)
}

/** Increment fail_count and return new value */
export function markReminderFailed(id: number): number {
  const d = getDb()
  d.prepare('UPDATE reminders SET fail_count = fail_count + 1 WHERE id = ?').run(id)
  const row = d.prepare('SELECT fail_count FROM reminders WHERE id = ?').get(id) as { fail_count: number } | undefined
  return row?.fail_count ?? 0
}

export function advanceReminderNextRun(id: number, nextRemindAt: number): void {
  getDb().prepare(
    "UPDATE reminders SET remind_at = ?, status = 'pending', fail_count = 0 WHERE id = ?"
  ).run(nextRemindAt, id)
}

export function listReminders(chatId: string): Reminder[] {
  return getDb().prepare(
    "SELECT * FROM reminders WHERE chat_id = ? AND status = 'pending' ORDER BY remind_at ASC"
  ).all(chatId) as unknown as Reminder[]
}

export function deleteReminder(id: number, chatId: string): boolean {
  const result = getDb().prepare(
    'DELETE FROM reminders WHERE id = ? AND chat_id = ?'
  ).run(id, chatId)
  return (result as unknown as { changes: number }).changes > 0
}

export function listAllReminders(): Reminder[] {
  return getDb().prepare(
    "SELECT * FROM reminders WHERE status = 'pending' ORDER BY remind_at ASC"
  ).all() as unknown as Reminder[]
}
