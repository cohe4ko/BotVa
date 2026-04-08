/**
 * Local JSON-backed store for ElevenLabs API keys.
 * Lives at `store/elevenlabs-keys.json` (gitignored, same place as other runtime data).
 *
 * Rotation is MANUAL: exactly one key may be marked `active` at a time; synthesis
 * uses only the active key. Automatic failover is deliberately not implemented —
 * ElevenLabs treats every key with equal strictness, so rotation under load just
 * burns them faster. The user picks which key to use from the admin UI.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
// dist/tts-providers/key-store.js → project root is ../..
// src/tts-providers/key-store.ts in dev (ts-node) → same relative layout.
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const STORE_DIR = resolve(PROJECT_ROOT, 'store')
const STORE_PATH = resolve(STORE_DIR, 'elevenlabs-keys.json')

export interface StoredKey {
  id: string
  key: string
  label: string
  used: number
  limit: number
  active: boolean
  added_at: number
  last_used?: number
  last_error?: string
  last_reconciled?: number
}

interface StoreFile { keys: StoredKey[] }

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
}

export function loadKeys(): StoredKey[] {
  try {
    const raw = readFileSync(STORE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as StoreFile
    return Array.isArray(parsed?.keys) ? parsed.keys : []
  } catch {
    return []
  }
}

export function saveKeys(keys: StoredKey[]): void {
  ensureDir()
  writeFileSync(STORE_PATH, JSON.stringify({ keys }, null, 2), 'utf-8')
}

export function getActiveKey(): StoredKey | null {
  const keys = loadKeys()
  return keys.find(k => k.active) ?? null
}

export function addKey(key: string, label: string, sub: { used: number; limit: number }): StoredKey {
  const keys = loadKeys()
  if (keys.some(k => k.key === key)) throw new Error('duplicate key')
  const id = randomBytes(4).toString('hex')
  // If no active key yet, make this one active automatically.
  const hasActive = keys.some(k => k.active)
  const entry: StoredKey = {
    id,
    key,
    label: label || 'key',
    used: sub.used,
    limit: sub.limit,
    active: !hasActive,
    added_at: Date.now(),
    last_reconciled: Date.now(),
  }
  keys.push(entry)
  saveKeys(keys)
  return entry
}

export function deleteKey(id: string): void {
  const keys = loadKeys()
  const next = keys.filter(k => k.id !== id)
  // If we removed the active one, auto-activate the first remaining.
  if (next.length > 0 && !next.some(k => k.active)) next[0].active = true
  saveKeys(next)
}

export function setActive(id: string): void {
  const keys = loadKeys()
  let found = false
  for (const k of keys) {
    if (k.id === id) { k.active = true; found = true }
    else k.active = false
  }
  if (!found) throw new Error(`key ${id} not found`)
  saveKeys(keys)
}

export function updateKey(id: string, patch: Partial<StoredKey>): void {
  const keys = loadKeys()
  const k = keys.find(x => x.id === id)
  if (!k) throw new Error(`key ${id} not found`)
  Object.assign(k, patch)
  saveKeys(keys)
}

export function incrementUsed(id: string, chars: number): void {
  const keys = loadKeys()
  const k = keys.find(x => x.id === id)
  if (!k) return
  k.used = (k.used || 0) + chars
  k.last_used = Date.now()
  saveKeys(keys)
}

/** Preview for UI — never return the raw key. */
export function redactKey(k: StoredKey): Omit<StoredKey, 'key'> & { key_preview: string } {
  const { key, ...rest } = k
  return { ...rest, key_preview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '' }
}
