import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Point the store to a unique temp file for every test.
const tmpDir = mkdtempSync(join(tmpdir(), 'groq-keys-test-'))
const storePath = join(tmpDir, 'groq-keys.json')
process.env.GROQ_STORE_PATH = storePath

import {
  loadStore, saveStore, pickKey, markUsed, markRateLimited, markError,
  parseRetryAfter, addKey, deleteKey, setEnabled, resetKey, ensureMigrated,
  listKeysRedacted, hasUsableKey, hasAnyKey, isRateLimited, redactKey,
  type GroqKey,
} from './groq-keys.js'

function wipeStore(): void {
  if (existsSync(storePath)) unlinkSync(storePath)
  const bak = storePath + '.bak'
  if (existsSync(bak)) unlinkSync(bak)
}

beforeEach(() => {
  wipeStore()
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadStore / saveStore', () => {
  it('returns empty store when file missing', () => {
    const s = loadStore()
    expect(s.keys).toEqual([])
    expect(s.round_robin_index).toBe(0)
  })

  it('round-trips a saved store', () => {
    const now = Date.now()
    saveStore({
      round_robin_index: 2,
      keys: [{
        id: 'a', key: 'gsk_aaa', label: 'one', enabled: true,
        added_at: now, usage_window_start: now,
        used_seconds: 100, limit_seconds: 7200,
        total_seconds: 500, total_requests: 3,
      }],
    })
    const s = loadStore()
    expect(s.round_robin_index).toBe(2)
    expect(s.keys).toHaveLength(1)
    expect(s.keys[0].key).toBe('gsk_aaa')
    expect(s.keys[0].used_seconds).toBe(100)
  })

  it('recovers from corrupt JSON by backing it up', () => {
    writeFileSync(storePath, '{not valid json', 'utf-8')
    const s = loadStore()
    expect(s.keys).toEqual([])
    expect(existsSync(storePath + '.bak')).toBe(true)
  })
})

describe('ensureMigrated', () => {
  it('imports new keys on empty store', () => {
    ensureMigrated([
      { key: 'gsk_one', label: 'primary' },
      { key: 'gsk_two' },
    ])
    const s = loadStore()
    expect(s.keys).toHaveLength(2)
    expect(s.keys[0].label).toBe('primary')
    expect(s.keys[1].label).toBe('migrated-2')
  })

  it('is idempotent — dedupes on second call', () => {
    ensureMigrated([{ key: 'gsk_one' }])
    ensureMigrated([{ key: 'gsk_one' }, { key: 'gsk_two' }])
    expect(loadStore().keys).toHaveLength(2)
  })

  it('ignores blank entries', () => {
    ensureMigrated([{ key: '' }, { key: '   ' }])
    expect(loadStore().keys).toHaveLength(0)
  })
})

describe('pickKey round-robin', () => {
  beforeEach(() => {
    addKey('gsk_a', 'a')
    addKey('gsk_b', 'b')
    addKey('gsk_c', 'c')
  })

  it('cycles through all keys in order and wraps', () => {
    const labels: string[] = []
    for (let i = 0; i < 6; i++) {
      labels.push(pickKey()!.label)
    }
    expect(labels).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })

  it('persists round_robin_index across load/save', () => {
    pickKey() // → a, index=1
    pickKey() // → b, index=2
    expect(loadStore().round_robin_index).toBe(2)
    // Fresh call still continues from index=2
    expect(pickKey()!.label).toBe('c')
  })

  it('skips rate-limited keys', () => {
    const store = loadStore()
    const aId = store.keys.find(k => k.label === 'a')!.id
    markRateLimited(aId, 600)
    const labels: string[] = []
    for (let i = 0; i < 4; i++) labels.push(pickKey()!.label)
    // "a" is skipped entirely.
    expect(labels).not.toContain('a')
    expect(labels).toEqual(['b', 'c', 'b', 'c'])
  })

  it('skips disabled keys', () => {
    const store = loadStore()
    const bId = store.keys.find(k => k.label === 'b')!.id
    setEnabled(bId, false)
    const labels: string[] = []
    for (let i = 0; i < 4; i++) labels.push(pickKey()!.label)
    expect(labels).not.toContain('b')
  })

  it('returns null when all keys are rate-limited', () => {
    for (const k of loadStore().keys) markRateLimited(k.id, 600)
    expect(pickKey()).toBeNull()
  })

  it('returns null when all keys are disabled', () => {
    for (const k of loadStore().keys) setEnabled(k.id, false)
    expect(pickKey()).toBeNull()
  })
})

describe('markUsed', () => {
  it('increments used_seconds and lifetime counters', () => {
    const k = addKey('gsk_x', 'x')
    markUsed(k.id, 42)
    markUsed(k.id, 8)
    const s = loadStore()
    expect(s.keys[0].used_seconds).toBe(50)
    expect(s.keys[0].total_seconds).toBe(50)
    expect(s.keys[0].total_requests).toBe(2)
  })

  it('rolls the hourly window when older than 1h', () => {
    const k = addKey('gsk_x', 'x')
    markUsed(k.id, 100)
    // Rewrite window_start to 2h ago.
    const store = loadStore()
    store.keys[0].usage_window_start = Date.now() - 2 * 60 * 60 * 1000
    saveStore(store)
    markUsed(k.id, 10)
    const s = loadStore()
    // used_seconds resets then +10
    expect(s.keys[0].used_seconds).toBe(10)
    // total is cumulative
    expect(s.keys[0].total_seconds).toBe(110)
  })

  it('clears last_error on success', () => {
    const k = addKey('gsk_x', 'x')
    markError(k.id, 'transient')
    markUsed(k.id, 5)
    expect(loadStore().keys[0].last_error).toBeUndefined()
  })
})

describe('markRateLimited', () => {
  it('uses retryAfterSec when provided', () => {
    const k = addKey('gsk_x', 'x')
    const before = Date.now()
    markRateLimited(k.id, 120)
    const stored = loadStore().keys[0]
    expect(stored.rate_limited_until).toBeDefined()
    const delta = stored.rate_limited_until! - before
    expect(delta).toBeGreaterThanOrEqual(120 * 1000 - 50)
    expect(delta).toBeLessThanOrEqual(120 * 1000 + 200)
  })

  it('falls back to 60 min when retryAfterSec missing', () => {
    const k = addKey('gsk_x', 'x')
    const before = Date.now()
    markRateLimited(k.id)
    const stored = loadStore().keys[0]
    const delta = stored.rate_limited_until! - before
    expect(delta).toBeGreaterThanOrEqual(60 * 60 * 1000 - 50)
    expect(delta).toBeLessThanOrEqual(60 * 60 * 1000 + 200)
  })

  it('sets last_error with ISO timestamp', () => {
    const k = addKey('gsk_x', 'x')
    markRateLimited(k.id, 60)
    expect(loadStore().keys[0].last_error).toMatch(/^429 rate-limited until/)
  })
})

describe('parseRetryAfter', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfter('60')).toBe(60)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('parses HTTP date as seconds-from-now', () => {
    const future = new Date(Date.now() + 30_000).toUTCString()
    const parsed = parseRetryAfter(future)
    expect(parsed).toBeGreaterThanOrEqual(28)
    expect(parsed).toBeLessThanOrEqual(32)
  })

  it('returns null for garbage', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter('not-a-date')).toBeNull()
  })

  it('returns 0 for past HTTP dates', () => {
    const past = new Date(Date.now() - 60_000).toUTCString()
    expect(parseRetryAfter(past)).toBe(0)
  })
})

describe('addKey', () => {
  it('rejects duplicates', () => {
    addKey('gsk_dup', 'first')
    expect(() => addKey('gsk_dup', 'second')).toThrow(/duplicate/)
  })

  it('rejects empty key', () => {
    expect(() => addKey('  ', 'x')).toThrow(/missing key/)
  })

  it('auto-labels when label missing', () => {
    addKey('gsk_a')
    addKey('gsk_b', '')
    const s = loadStore()
    expect(s.keys[0].label).toBe('key-1')
    expect(s.keys[1].label).toBe('key-2')
  })
})

describe('deleteKey', () => {
  it('clamps round_robin_index after deletion', () => {
    const a = addKey('gsk_a', 'a')
    addKey('gsk_b', 'b')
    addKey('gsk_c', 'c')
    // Advance index past what will remain.
    pickKey(); pickKey(); pickKey() // index now 0 again after 3 picks
    pickKey() // index = 1 (after picking 'a')
    deleteKey(a.id)
    const s = loadStore()
    // 2 keys left → index must be < 2
    expect(s.round_robin_index).toBeLessThan(2)
  })

  it('resets index to 0 when store becomes empty', () => {
    const a = addKey('gsk_a', 'a')
    pickKey()
    deleteKey(a.id)
    expect(loadStore().round_robin_index).toBe(0)
  })
})

describe('resetKey', () => {
  it('clears rate_limited_until and last_error', () => {
    const k = addKey('gsk_x', 'x')
    markRateLimited(k.id, 600)
    markError(k.id, 'boom')
    resetKey(k.id)
    const stored = loadStore().keys[0]
    expect(stored.rate_limited_until).toBeUndefined()
    expect(stored.last_error).toBeUndefined()
  })
})

describe('hasUsableKey / hasAnyKey', () => {
  it('both false on empty store', () => {
    expect(hasAnyKey()).toBe(false)
    expect(hasUsableKey()).toBe(false)
  })

  it('hasAnyKey true but hasUsableKey false when all rate-limited', () => {
    const k = addKey('gsk_x', 'x')
    markRateLimited(k.id, 600)
    expect(hasAnyKey()).toBe(true)
    expect(hasUsableKey()).toBe(false)
  })
})

describe('listKeysRedacted', () => {
  it('masks raw key and exposes key_preview', () => {
    addKey('gsk_abcdefghij', 'main')
    const list = listKeysRedacted()
    expect(list).toHaveLength(1)
    expect((list[0] as any).key).toBeUndefined()
    expect(list[0].key_preview).toBe('gsk_…ghij')
  })

  it('rolls stale hourly window on read', () => {
    const k = addKey('gsk_x', 'x')
    markUsed(k.id, 500)
    const store = loadStore()
    store.keys[0].usage_window_start = Date.now() - 2 * 60 * 60 * 1000
    saveStore(store)
    const list = listKeysRedacted()
    expect(list[0].used_seconds).toBe(0)
  })
})

describe('isRateLimited', () => {
  it('returns false when rate_limited_until is missing or past', () => {
    const now = Date.now()
    const fresh: GroqKey = {
      id: 'a', key: 'x', label: 'l', enabled: true, added_at: now,
      usage_window_start: now, used_seconds: 0, limit_seconds: 7200,
      total_seconds: 0, total_requests: 0,
    }
    expect(isRateLimited(fresh, now)).toBe(false)
    fresh.rate_limited_until = now - 1000
    expect(isRateLimited(fresh, now)).toBe(false)
    fresh.rate_limited_until = now + 1000
    expect(isRateLimited(fresh, now)).toBe(true)
  })
})
