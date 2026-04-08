/**
 * Local JSON-backed store for Groq STT (Whisper) API keys.
 * Lives at `store/groq-keys.json` (gitignored, shared across all bots + listener).
 *
 * Unlike ElevenLabs where rotation is manual, Groq rotation is AUTOMATIC:
 * the store tracks per-key `used_seconds` against the Groq ASPH limit
 * (7200 sec/hour per organization), rolls the window every hour, and
 * temporarily disables keys that hit 429 via `rate_limited_until`.
 *
 * Selection strategy: persistent round-robin (`round_robin_index`),
 * skipping disabled or rate-limited keys.
 *
 * Atomic writes: tmp → rename, so both main bot and listener processes
 * can share the file without corruption.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
// dist/groq-keys.js or src/groq-keys.ts → project root is ..
const PROJECT_ROOT = resolve(__dirname, '..')
const DEFAULT_STORE_DIR = resolve(PROJECT_ROOT, 'store')
const DEFAULT_STORE_PATH = resolve(DEFAULT_STORE_DIR, 'groq-keys.json')

// Override via env var (used by tests) — must be set before first load.
function storePath(): string {
  return process.env.GROQ_STORE_PATH || DEFAULT_STORE_PATH
}
function storeDir(): string {
  return dirname(storePath())
}

export interface GroqKey {
  id: string
  key: string
  label: string
  enabled: boolean
  added_at: number
  last_used?: number
  last_error?: string
  /** ISO ms timestamp; when > now, key is on cooldown and skipped by pickKey. */
  rate_limited_until?: number
  /** Start of the current rolling-hour window (ms). */
  usage_window_start: number
  /** Seconds of audio consumed in the current window. */
  used_seconds: number
  /** Groq ASPH limit in seconds (default 7200 = 2h audio / hour). */
  limit_seconds: number
  /** Lifetime counters (never reset). */
  total_seconds: number
  total_requests: number
}

export interface GroqKeyStore {
  round_robin_index: number
  keys: GroqKey[]
}

export interface RedactedGroqKey extends Omit<GroqKey, 'key'> {
  key_preview: string
}

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_LIMIT_SECONDS = 7200
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour

function ensureDir(): void {
  const d = storeDir()
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

function emptyStore(): GroqKeyStore {
  return { round_robin_index: 0, keys: [] }
}

/** Atomic read — on parse failure, backs up corrupt file and returns empty store. */
export function loadStore(): GroqKeyStore {
  const p = storePath()
  if (!existsSync(p)) return emptyStore()
  try {
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<GroqKeyStore>
    if (!parsed || !Array.isArray(parsed.keys)) return emptyStore()
    return {
      round_robin_index: Number(parsed.round_robin_index ?? 0),
      keys: parsed.keys.map(normalizeKey),
    }
  } catch {
    // Corrupt file — back up and start fresh.
    try { renameSync(p, p + '.bak') } catch { /* best effort */ }
    return emptyStore()
  }
}

function normalizeKey(k: Partial<GroqKey> & { key: string }): GroqKey {
  return {
    id: k.id ?? randomBytes(4).toString('hex'),
    key: k.key,
    label: k.label ?? 'key',
    enabled: k.enabled !== false,
    added_at: Number(k.added_at ?? Date.now()),
    last_used: k.last_used,
    last_error: k.last_error,
    rate_limited_until: k.rate_limited_until,
    usage_window_start: Number(k.usage_window_start ?? Date.now()),
    used_seconds: Number(k.used_seconds ?? 0),
    limit_seconds: Number(k.limit_seconds ?? DEFAULT_LIMIT_SECONDS),
    total_seconds: Number(k.total_seconds ?? 0),
    total_requests: Number(k.total_requests ?? 0),
  }
}

/** Atomic write via tmp → rename to survive concurrent writes from bot + listener. */
export function saveStore(store: GroqKeyStore): void {
  ensureDir()
  const p = storePath()
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  renameSync(tmp, p)
}

/**
 * Import keys from the environment on first run. Idempotent: dedupes against
 * existing keys. Call this from transcribeAudio / listener startup with whatever
 * keys are available in the current process env — store survives migration.
 */
export function ensureMigrated(candidates: Array<{ key: string; label?: string }>): void {
  if (candidates.length === 0) return
  const store = loadStore()
  const existing = new Set(store.keys.map(k => k.key))
  let added = false
  for (const c of candidates) {
    const trimmed = c.key?.trim()
    if (!trimmed || existing.has(trimmed)) continue
    store.keys.push(normalizeKey({
      key: trimmed,
      label: c.label || `migrated-${store.keys.length + 1}`,
      added_at: Date.now(),
      usage_window_start: Date.now(),
    }))
    existing.add(trimmed)
    added = true
  }
  if (added) saveStore(store)
}

/** True if the key is currently in a 429 cooldown window. */
export function isRateLimited(k: GroqKey, now: number = Date.now()): boolean {
  return !!(k.rate_limited_until && k.rate_limited_until > now)
}

/**
 * Pick the next usable key via round-robin. Returns null if every key is
 * disabled or rate-limited. Persists the updated index on success.
 */
export function pickKey(now: number = Date.now()): { id: string; key: string; label: string } | null {
  const store = loadStore()
  const n = store.keys.length
  if (n === 0) return null

  for (let i = 0; i < n; i++) {
    const idx = (store.round_robin_index + i) % n
    const k = store.keys[idx]
    if (!k.enabled) continue
    if (isRateLimited(k, now)) continue
    // Advance index for next call — start from the one after this.
    store.round_robin_index = (idx + 1) % n
    k.last_used = now
    saveStore(store)
    return { id: k.id, key: k.key, label: k.label }
  }
  return null
}

/** Roll the hourly window if the current window is older than 1h. */
function rollWindowIfNeeded(k: GroqKey, now: number): void {
  if (now - k.usage_window_start >= HOUR_MS) {
    k.usage_window_start = now
    k.used_seconds = 0
  }
}

/** Record successful transcription: seconds of audio consumed. */
export function markUsed(id: string, seconds: number, now: number = Date.now()): void {
  const store = loadStore()
  const k = store.keys.find(x => x.id === id)
  if (!k) return
  rollWindowIfNeeded(k, now)
  k.used_seconds += seconds
  k.total_seconds += seconds
  k.total_requests += 1
  k.last_used = now
  // Clear transient error on success.
  k.last_error = undefined
  saveStore(store)
}

/** Put a key on cooldown after a 429. retryAfterSec may come from Retry-After header. */
export function markRateLimited(id: string, retryAfterSec?: number, now: number = Date.now()): void {
  const store = loadStore()
  const k = store.keys.find(x => x.id === id)
  if (!k) return
  const cooldownMs = retryAfterSec && retryAfterSec > 0 ? retryAfterSec * 1000 : DEFAULT_COOLDOWN_MS
  k.rate_limited_until = now + cooldownMs
  k.last_error = `429 rate-limited until ${new Date(k.rate_limited_until).toISOString()}`
  saveStore(store)
}

/** Record a non-429 error against a key without disabling it. */
export function markError(id: string, msg: string): void {
  const store = loadStore()
  const k = store.keys.find(x => x.id === id)
  if (!k) return
  k.last_error = msg.slice(0, 200)
  saveStore(store)
}

/** Parse a Retry-After header (seconds or HTTP-date). Returns seconds or null. */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null
  const asNum = Number(header)
  if (Number.isFinite(asNum) && asNum >= 0) return Math.floor(asNum)
  const asDate = Date.parse(header)
  if (!Number.isNaN(asDate)) {
    const diff = Math.floor((asDate - Date.now()) / 1000)
    return diff > 0 ? diff : 0
  }
  return null
}

// ---- Admin operations ----

export function addKey(rawKey: string, label?: string): GroqKey {
  const trimmed = rawKey.trim()
  if (!trimmed) throw new Error('missing key')
  const store = loadStore()
  if (store.keys.some(k => k.key === trimmed)) throw new Error('duplicate key')
  const entry = normalizeKey({
    key: trimmed,
    label: (label || '').trim() || `key-${store.keys.length + 1}`,
    added_at: Date.now(),
    usage_window_start: Date.now(),
  })
  store.keys.push(entry)
  saveStore(store)
  return entry
}

export function deleteKey(id: string): void {
  const store = loadStore()
  const idx = store.keys.findIndex(k => k.id === id)
  if (idx === -1) return
  store.keys.splice(idx, 1)
  // Clamp round_robin_index so it stays in range.
  if (store.keys.length === 0) {
    store.round_robin_index = 0
  } else {
    store.round_robin_index = store.round_robin_index % store.keys.length
  }
  saveStore(store)
}

export function setEnabled(id: string, enabled: boolean): void {
  const store = loadStore()
  const k = store.keys.find(x => x.id === id)
  if (!k) return
  k.enabled = enabled
  saveStore(store)
}

/** Clear rate-limit cooldown and last error for a key. */
export function resetKey(id: string): void {
  const store = loadStore()
  const k = store.keys.find(x => x.id === id)
  if (!k) return
  k.rate_limited_until = undefined
  k.last_error = undefined
  saveStore(store)
}

/** Validate a Groq key by calling the models endpoint. Throws on failure. */
export async function validateKey(rawKey: string): Promise<void> {
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    method: 'GET',
    headers: { Authorization: `Bearer ${rawKey}` },
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`groq validation ${r.status}: ${txt.slice(0, 200)}`)
  }
}

export function redactKey(k: GroqKey): RedactedGroqKey {
  const { key, ...rest } = k
  return { ...rest, key_preview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '' }
}

export function listKeysRedacted(): RedactedGroqKey[] {
  // Roll windows on read so admin UI shows fresh used_seconds after an hour of inactivity.
  const store = loadStore()
  const now = Date.now()
  let dirty = false
  for (const k of store.keys) {
    if (now - k.usage_window_start >= HOUR_MS && k.used_seconds > 0) {
      k.usage_window_start = now
      k.used_seconds = 0
      dirty = true
    }
  }
  if (dirty) saveStore(store)
  return store.keys.map(redactKey)
}

/** True if there's at least one enabled, non-rate-limited key. */
export function hasUsableKey(): boolean {
  const store = loadStore()
  const now = Date.now()
  return store.keys.some(k => k.enabled && !isRateLimited(k, now))
}

/** True if there's at least one key in the store (regardless of state). */
export function hasAnyKey(): boolean {
  return loadStore().keys.length > 0
}
