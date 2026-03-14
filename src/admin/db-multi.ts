import { DatabaseSync } from 'node:sqlite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readdirSync, statSync, mkdirSync } from 'fs'
import { imageTokenCost, IMAGE_OUTPUT_TOKEN_PRICE } from '../pricing.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')

export type BotName = string

/** Discover bot directories dynamically from bots/ */
export function getBotNames(): BotName[] {
  const botsDir = resolve(PROJECT_ROOT, 'bots')
  if (!existsSync(botsDir)) return []
  return readdirSync(botsDir)
    .filter(name => {
      if (name.startsWith('.')) return false
      const dir = resolve(botsDir, name)
      return statSync(dir).isDirectory()
    })
    .sort()
}

const connections = new Map<BotName, DatabaseSync>()

export function getBotDb(name: BotName): DatabaseSync {
  let db = connections.get(name)
  if (db) return db

  const dbPath = resolve(PROJECT_ROOT, 'bots', name, 'store', 'botva.db')
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found for bot ${name}: ${dbPath}`)
  }

  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA trusted_schema = ON')
  connections.set(name, db)
  return db
}

export function getBotDir(name: BotName): string {
  return resolve(PROJECT_ROOT, 'bots', name)
}

export function getProjectRoot(): string {
  return PROJECT_ROOT
}

export function closeAll(): void {
  for (const [, db] of connections) {
    try { db.close() } catch { /* ignore */ }
  }
  connections.clear()
}

// --- Query helpers ---

export interface Memory {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
}

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

export interface UsageRow {
  id: number
  chat_id: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number
  created_at: number
}

export interface Session {
  chat_id: string
  session_id: string
  updated_at: number
}

export interface ChatSetting {
  chat_id: string
  key: string
  value: string
}

// Memories
export function getMemories(bot: BotName, limit = 50, offset = 0, query?: string): Memory[] {
  const db = getBotDb(bot)
  if (query) {
    const sanitized = query.replace(/[^\w\s]/g, '').trim()
    if (!sanitized) return []
    const ftsQuery = sanitized.split(/\s+/).map(w => `${w}*`).join(' ')
    try {
      return db.prepare(`
        SELECT m.* FROM memories m
        JOIN memories_fts f ON f.rowid = m.id
        WHERE memories_fts MATCH ?
        ORDER BY rank
        LIMIT ? OFFSET ?
      `).all(ftsQuery, limit, offset) as unknown as Memory[]
    } catch { return [] }
  }
  return db.prepare('SELECT * FROM memories ORDER BY accessed_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as unknown as Memory[]
}

export function countMemories(bot: BotName, query?: string): number {
  const db = getBotDb(bot)
  if (query) {
    const sanitized = query.replace(/[^\w\s]/g, '').trim()
    if (!sanitized) return 0
    const ftsQuery = sanitized.split(/\s+/).map(w => `${w}*`).join(' ')
    try {
      const row = db.prepare(`
        SELECT COUNT(*) as cnt FROM memories m
        JOIN memories_fts f ON f.rowid = m.id
        WHERE memories_fts MATCH ?
      `).get(ftsQuery) as unknown as { cnt: number }
      return row.cnt
    } catch { return 0 }
  }
  const row = db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as unknown as { cnt: number }
  return row.cnt
}

export function updateMemorySalience(bot: BotName, id: number, salience: number): boolean {
  const db = getBotDb(bot)
  const r = db.prepare('UPDATE memories SET salience = ? WHERE id = ?').run(salience, id)
  return r.changes > 0
}

export function deleteMemory(bot: BotName, id: number): boolean {
  const db = getBotDb(bot)
  // Drop the FTS delete trigger, delete manually, then recreate
  db.exec('DROP TRIGGER IF EXISTS memories_ad')
  try {
    db.prepare("INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', ?, (SELECT content FROM memories WHERE id = ?))").run(id, id)
  } catch { /* FTS entry may not exist */ }
  const r = db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  db.exec(`CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
  END`)
  return r.changes > 0
}

// Tasks
export function getTasks(bot: BotName): ScheduledTask[] {
  return getBotDb(bot).prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as unknown as ScheduledTask[]
}

export function getTask(bot: BotName, id: string): ScheduledTask | undefined {
  return getBotDb(bot).prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as unknown as ScheduledTask | undefined
}

export function createTask(bot: BotName, id: string, chatId: string, prompt: string, schedule: string, nextRun: number): void {
  const now = Math.floor(Date.now() / 1000)
  getBotDb(bot).prepare(
    'INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, chatId, prompt, schedule, nextRun, 'active', now)
}

export function updateTask(bot: BotName, id: string, prompt: string, schedule: string): boolean {
  const r = getBotDb(bot).prepare('UPDATE scheduled_tasks SET prompt = ?, schedule = ? WHERE id = ?')
    .run(prompt, schedule, id)
  return r.changes > 0
}

export function deleteTask(bot: BotName, id: string): boolean {
  const r = getBotDb(bot).prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
  return r.changes > 0
}

export function pauseTask(bot: BotName, id: string): boolean {
  const r = getBotDb(bot).prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id)
  return r.changes > 0
}

export function resumeTask(bot: BotName, id: string): boolean {
  const r = getBotDb(bot).prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id)
  return r.changes > 0
}

// Reminders
export interface AdminReminder {
  id: number
  chat_id: string
  text: string
  remind_at: number
  created_at: number
  status: 'pending' | 'sent'
}

export function getReminders(bot: BotName, status?: 'pending' | 'sent'): AdminReminder[] {
  const db = getBotDb(bot)
  try {
    if (status) {
      return db.prepare('SELECT * FROM reminders WHERE status = ? ORDER BY remind_at ASC')
        .all(status) as unknown as AdminReminder[]
    }
    return db.prepare('SELECT * FROM reminders ORDER BY remind_at DESC')
      .all() as unknown as AdminReminder[]
  } catch { return [] }
}

export function createReminder(bot: BotName, chatId: string, text: string, remindAt: number): number {
  const now = Math.floor(Date.now() / 1000)
  const result = getBotDb(bot).prepare(
    'INSERT INTO reminders (chat_id, text, remind_at, created_at) VALUES (?, ?, ?, ?)'
  ).run(chatId, text, remindAt, now)
  return Number((result as unknown as { lastInsertRowid: bigint }).lastInsertRowid)
}

export function deleteReminder(bot: BotName, id: number): boolean {
  const r = getBotDb(bot).prepare('DELETE FROM reminders WHERE id = ?').run(id)
  return r.changes > 0
}

// Sessions
export function getSessions(bot: BotName): Session[] {
  return getBotDb(bot).prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
    .all() as unknown as Session[]
}

export function deleteSession(bot: BotName, chatId: string): boolean {
  const r = getBotDb(bot).prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
  return r.changes > 0
}

// Settings
export function getSettings(bot: BotName): ChatSetting[] {
  return getBotDb(bot).prepare('SELECT * FROM chat_settings ORDER BY chat_id, key')
    .all() as unknown as ChatSetting[]
}

export function upsertSetting(bot: BotName, chatId: string, key: string, value: string): void {
  getBotDb(bot).prepare(
    'INSERT INTO chat_settings (chat_id, key, value) VALUES (?, ?, ?) ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value'
  ).run(chatId, key, value)
}

export function deleteSetting(bot: BotName, chatId: string, key: string): boolean {
  const r = getBotDb(bot).prepare('DELETE FROM chat_settings WHERE chat_id = ? AND key = ?').run(chatId, key)
  return r.changes > 0
}

// Facts (long-term memory)
export interface FactRow {
  id: number
  chat_id: string
  topic: string
  content: string
  tags: string
  source: string
  sector: 'semantic' | 'episodic'
  created_at: number
  updated_at: number
}

function ensureFactsTable(bot: BotName): boolean {
  const db = getBotDb(bot)
  const check = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facts'").get()
  return !!check
}

export function getFacts(bot: BotName, limit = 50, offset = 0, query?: string, topic?: string): FactRow[] {
  if (!ensureFactsTable(bot)) return []
  const db = getBotDb(bot)
  if (query) {
    const sanitized = query.replace(/[^\w\s\u0400-\u04FF]/g, '').trim()
    if (!sanitized) return []
    const ftsQuery = sanitized.split(/\s+/).map(w => `${w}*`).join(' OR ')
    try {
      let sql = `SELECT f.* FROM facts f JOIN facts_fts ff ON ff.rowid = f.id WHERE facts_fts MATCH ?`
      const params: (string | number)[] = [ftsQuery]
      if (topic) { sql += ' AND f.topic = ?'; params.push(topic) }
      sql += ' ORDER BY rank LIMIT ? OFFSET ?'
      params.push(limit, offset)
      return db.prepare(sql).all(...params) as unknown as FactRow[]
    } catch { return [] }
  }
  let sql = 'SELECT * FROM facts WHERE 1=1'
  const params: (string | number)[] = []
  if (topic) { sql += ' AND topic = ?'; params.push(topic) }
  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)
  return db.prepare(sql).all(...params) as unknown as FactRow[]
}

export function countFacts(bot: BotName, query?: string, topic?: string): number {
  if (!ensureFactsTable(bot)) return 0
  const db = getBotDb(bot)
  if (query) {
    const sanitized = query.replace(/[^\w\s\u0400-\u04FF]/g, '').trim()
    if (!sanitized) return 0
    const ftsQuery = sanitized.split(/\s+/).map(w => `${w}*`).join(' OR ')
    try {
      let sql = `SELECT COUNT(*) as cnt FROM facts f JOIN facts_fts ff ON ff.rowid = f.id WHERE facts_fts MATCH ?`
      const params: (string | number)[] = [ftsQuery]
      if (topic) { sql += ' AND f.topic = ?'; params.push(topic) }
      return (db.prepare(sql).get(...params) as unknown as { cnt: number }).cnt
    } catch { return 0 }
  }
  let sql = 'SELECT COUNT(*) as cnt FROM facts WHERE 1=1'
  const params: string[] = []
  if (topic) { sql += ' AND topic = ?'; params.push(topic) }
  return (db.prepare(sql).get(...params) as unknown as { cnt: number }).cnt
}

export function getFactTopics(bot: BotName): { topic: string; count: number }[] {
  if (!ensureFactsTable(bot)) return []
  return getBotDb(bot).prepare('SELECT topic, COUNT(*) as count FROM facts GROUP BY topic ORDER BY count DESC')
    .all() as unknown as { topic: string; count: number }[]
}

export function updateFactContent(bot: BotName, id: number, content: string, tags: string): boolean {
  if (!ensureFactsTable(bot)) return false
  const db = getBotDb(bot)
  const now = Math.floor(Date.now() / 1000)
  // Manual FTS sync
  try {
    const old = db.prepare('SELECT content, tags FROM facts WHERE id = ?').get(id) as { content: string; tags: string } | undefined
    if (old) {
      db.prepare("INSERT INTO facts_fts(facts_fts, rowid, content, tags) VALUES('delete', ?, ?, ?)").run(id, old.content, old.tags)
    }
  } catch { /* FTS may be out of sync */ }
  const r = db.prepare('UPDATE facts SET content = ?, tags = ?, updated_at = ? WHERE id = ?').run(content, tags, now, id)
  if (r.changes > 0) {
    try { db.prepare('INSERT INTO facts_fts(rowid, content, tags) VALUES(?, ?, ?)').run(id, content, tags) } catch { /* ignore */ }
  }
  return r.changes > 0
}

export function deleteFact(bot: BotName, id: number): boolean {
  if (!ensureFactsTable(bot)) return false
  const db = getBotDb(bot)
  try {
    const row = db.prepare('SELECT content, tags FROM facts WHERE id = ?').get(id) as { content: string; tags: string } | undefined
    if (row) {
      db.prepare("INSERT INTO facts_fts(facts_fts, rowid, content, tags) VALUES('delete', ?, ?, ?)").run(id, row.content, row.tags)
    }
  } catch { /* FTS may be out of sync */ }
  const r = db.prepare('DELETE FROM facts WHERE id = ?').run(id)
  return r.changes > 0
}

// Audit log
export interface AuditRow {
  id: number
  chat_id: string | null
  event_type: string
  detail: string | null
  created_at: number
}

export function getAuditLogs(bot: BotName, limit = 50, offset = 0, eventType?: string, search?: string): AuditRow[] {
  const db = getBotDb(bot)
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get()
  if (!tableCheck) return []

  let sql = 'SELECT * FROM audit_log WHERE 1=1'
  const params: (string | number)[] = []
  if (eventType) {
    sql += ' AND event_type = ?'
    params.push(eventType)
  }
  if (search) {
    sql += ' AND detail LIKE ?'
    params.push(`%${search}%`)
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)
  return db.prepare(sql).all(...params) as unknown as AuditRow[]
}

export function countAuditLogs(bot: BotName, eventType?: string, search?: string): number {
  const db = getBotDb(bot)
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get()
  if (!tableCheck) return 0

  let sql = 'SELECT COUNT(*) as cnt FROM audit_log WHERE 1=1'
  const params: string[] = []
  if (eventType) {
    sql += ' AND event_type = ?'
    params.push(eventType)
  }
  if (search) {
    sql += ' AND detail LIKE ?'
    params.push(`%${search}%`)
  }
  const row = db.prepare(sql).get(...params) as unknown as { cnt: number }
  return row.cnt
}

export function getAuditEventTypes(bot: BotName): string[] {
  const db = getBotDb(bot)
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get()
  if (!tableCheck) return []
  const rows = db.prepare('SELECT DISTINCT event_type FROM audit_log ORDER BY event_type').all() as unknown as { event_type: string }[]
  return rows.map(r => r.event_type)
}

// Health metrics
export interface HealthMetrics {
  lastActivity: number | null
  avgResponseTimeMs: number | null
  errorCount24h: number
  requestCount24h: number
}

export function getHealthMetrics(bot: BotName): HealthMetrics {
  const db = getBotDb(bot)
  const dayAgo = Math.floor(Date.now() / 1000) - 86400

  const lastRow = db.prepare('SELECT MAX(created_at) as last_at FROM usage_log').get() as unknown as { last_at: number | null }

  let avgResponseTimeMs: number | null = null
  let requestCount24h = 0
  try {
    const avgRow = db.prepare(
      'SELECT AVG(response_time_ms) as avg_ms, COUNT(*) as cnt FROM usage_log WHERE created_at >= ? AND response_time_ms IS NOT NULL'
    ).get(dayAgo) as unknown as { avg_ms: number | null; cnt: number }
    avgResponseTimeMs = avgRow.avg_ms ? Math.round(avgRow.avg_ms) : null
    requestCount24h = avgRow.cnt
  } catch {
    const cntRow = db.prepare('SELECT COUNT(*) as cnt FROM usage_log WHERE created_at >= ?').get(dayAgo) as unknown as { cnt: number }
    requestCount24h = cntRow.cnt
  }

  let errorCount24h = 0
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get()
  if (tableCheck) {
    const errRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM audit_log WHERE event_type = 'error' AND created_at >= ?"
    ).get(dayAgo) as unknown as { cnt: number }
    errorCount24h = errRow.cnt
  }

  return { lastActivity: lastRow.last_at, avgResponseTimeMs, errorCount24h, requestCount24h }
}

// Usage
export function getUsageSummary(bot: BotName, sinceTs: number): { requests: number; costUSD: number; inputTokens: number; outputTokens: number } {
  const row = getBotDb(bot).prepare(
    'SELECT COUNT(*) as requests, COALESCE(SUM(cost_usd),0) as costUSD, COALESCE(SUM(input_tokens),0) as inputTokens, COALESCE(SUM(output_tokens),0) as outputTokens FROM usage_log WHERE created_at >= ?'
  ).get(sinceTs) as unknown as { requests: number; costUSD: number; inputTokens: number; outputTokens: number }
  return row
}

export function getUsageDaily(bot: BotName, days = 30): { date: string; cost: number; requests: number }[] {
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400
  const rows = getBotDb(bot).prepare(`
    SELECT date(created_at, 'unixepoch', 'localtime') as date,
           SUM(cost_usd) as cost,
           COUNT(*) as requests
    FROM usage_log
    WHERE created_at >= ?
    GROUP BY date
    ORDER BY date
  `).all(sinceTs) as unknown as { date: string; cost: number; requests: number }[]
  return rows
}

export function getUsageRows(bot: BotName, limit = 50): UsageRow[] {
  return getBotDb(bot).prepare('SELECT * FROM usage_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as UsageRow[]
}

// Imagen usage
export interface ImagenRow {
  id: number
  type: string
  prompt: string
  model: string
  input_tokens: number
  output_tokens: number
  image_bytes: number
  created_at: number
}

function ensureImagenTable(bot: BotName): void {
  const db = getBotDb(bot)
  db.exec(`
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
}

export function getImagenSummary(bot: BotName, sinceTs: number): { total: number; generates: number; edits: number; inputTokens: number; outputTokens: number; totalImageBytes: number; estimatedCostUSD: number } {
  ensureImagenTable(bot)
  const row = getBotDb(bot).prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN type = 'generate' THEN 1 ELSE 0 END) as generates,
      SUM(CASE WHEN type = 'edit' THEN 1 ELSE 0 END) as edits,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(image_bytes), 0) as totalImageBytes
    FROM imagen_usage WHERE created_at >= ?
  `).get(sinceTs) as unknown as { total: number; generates: number; edits: number; inputTokens: number; outputTokens: number; totalImageBytes: number }
  return { ...row, estimatedCostUSD: imageTokenCost(row.outputTokens ?? 0) }
}

export function getImagenRows(bot: BotName, limit = 50): ImagenRow[] {
  ensureImagenTable(bot)
  return getBotDb(bot).prepare('SELECT * FROM imagen_usage ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as ImagenRow[]
}

export function getImagenDaily(bot: BotName, days = 30): { date: string; count: number; cost: number }[] {
  ensureImagenTable(bot)
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400
  return getBotDb(bot).prepare(`
    SELECT date(created_at, 'unixepoch', 'localtime') as date,
           COUNT(*) as count,
           COALESCE(SUM(output_tokens), 0) * ${IMAGE_OUTPUT_TOKEN_PRICE} as cost
    FROM imagen_usage
    WHERE created_at >= ?
    GROUP BY date
    ORDER BY date
  `).all(sinceTs) as unknown as { date: string; count: number; cost: number }[]
}

// === Shared Gallery ===

let galleryDb: DatabaseSync | null = null

function getGalleryDb(): DatabaseSync {
  if (galleryDb) return galleryDb
  const wsDir = resolve(PROJECT_ROOT, 'workspace')
  if (!existsSync(wsDir)) mkdirSync(wsDir, { recursive: true })
  const dbPath = resolve(wsDir, 'gallery.db')
  galleryDb = new DatabaseSync(dbPath)
  galleryDb.exec('PRAGMA journal_mode = WAL')
  galleryDb.exec(`
    CREATE TABLE IF NOT EXISTS gallery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('generate','edit')),
      prompt TEXT NOT NULL,
      filename TEXT NOT NULL,
      image_bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `)
  return galleryDb
}

export interface GalleryRow {
  id: number
  bot_name: string
  type: string
  prompt: string
  filename: string
  image_bytes: number
  created_at: number
}

export function addGalleryImage(botName: string, type: 'generate' | 'edit', prompt: string, filename: string, imageBytes: number): void {
  const db = getGalleryDb()
  const now = Math.floor(Date.now() / 1000)
  db.prepare('INSERT INTO gallery (bot_name, type, prompt, filename, image_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(botName, type, prompt, filename, imageBytes, now)
}

export function getGalleryImages(limit = 24, offset = 0, bot?: string): GalleryRow[] {
  const db = getGalleryDb()
  if (bot) {
    return db.prepare('SELECT * FROM gallery WHERE bot_name = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(bot, limit, offset) as unknown as GalleryRow[]
  }
  return db.prepare('SELECT * FROM gallery ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as unknown as GalleryRow[]
}

export function countGalleryImages(bot?: string): number {
  const db = getGalleryDb()
  if (bot) {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM gallery WHERE bot_name = ?').get(bot) as unknown as { cnt: number }
    return row.cnt
  }
  const row = db.prepare('SELECT COUNT(*) as cnt FROM gallery').get() as unknown as { cnt: number }
  return row.cnt
}

export function getGalleryImageById(id: number): GalleryRow | null {
  const db = getGalleryDb()
  const row = db.prepare('SELECT * FROM gallery WHERE id = ?').get(id) as unknown as GalleryRow | undefined
  return row ?? null
}

export function deleteGalleryImage(id: number): GalleryRow | null {
  const db = getGalleryDb()
  const row = db.prepare('SELECT * FROM gallery WHERE id = ?').get(id) as unknown as GalleryRow | undefined
  if (!row) return null
  db.prepare('DELETE FROM gallery WHERE id = ?').run(id)
  return row as GalleryRow
}
