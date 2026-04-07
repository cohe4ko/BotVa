import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// vi.hoisted runs before vi.mock hoisting
const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-test-'))
})

vi.mock('./config.js', () => ({
  STORE_DIR: testDir,
}))

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('./pricing.js', () => ({
  imageTokenCost: vi.fn(() => 0),
}))

import {
  initDatabase,
  insertFact,
  insertFactsBatch,
  computeFactHash,
  searchFacts,
  deleteFact,
  updateFact,
  getChatSetting,
  setChatSetting,
  deleteChatSetting,
  getApprovedGroups,
  addApprovedGroup,
  removeApprovedGroup,
  bumpFactUsefulness,
  getDb,
} from './db.js'

import { logger } from './logger.js'

const CHAT = 'test-chat-1'

beforeAll(() => {
  initDatabase()
})

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* ok */ }
})

describe('facts CRUD', () => {
  it('insertFact returns positive id', () => {
    const id = insertFact(CHAT, 'Likes coffee', 'preferences', 'semantic')
    expect(id).toBeGreaterThan(0)
  })

  it('searchFacts finds inserted fact via FTS', () => {
    insertFact(CHAT, 'User prefers dark mode', 'ui', 'semantic')
    const results = searchFacts(CHAT, 'dark mode')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some(f => f.content.includes('dark mode'))).toBe(true)
  })

  it('searchFacts with empty query returns empty', () => {
    expect(searchFacts(CHAT, '')).toEqual([])
    expect(searchFacts(CHAT, '!!!')).toEqual([])
  })

  it('searchFacts with topic filter', () => {
    insertFact(CHAT, 'Uses VS Code', 'tools', 'semantic')
    insertFact(CHAT, 'Uses vim', 'tools', 'semantic')
    const results = searchFacts(CHAT, 'uses', 10, 'tools')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.every(f => f.topic === 'tools')).toBe(true)
  })

  it('deleteFact removes fact', () => {
    const id = insertFact(CHAT, 'temporary fact', 'temp', 'episodic')
    expect(deleteFact(id, CHAT)).toBe(true)
    const results = searchFacts(CHAT, 'temporary fact')
    expect(results.find(f => f.id === id)).toBeUndefined()
  })

  it('deleteFact returns false for non-existent', () => {
    expect(deleteFact(999999, CHAT)).toBe(false)
  })

  // Regression: before 2026-04-07 deleteFact used the external-content
  // FTS5 delete syntax, which throws "SQL logic error" on a regular FTS5
  // table. The operation logged an error and left an orphan FTS row that
  // accumulated over time. Ensures the proper DELETE is now used.
  it('deleteFact does not log FTS errors and cleans up FTS row', () => {
    const errorSpy = vi.mocked(logger.error)
    errorSpy.mockClear()
    const id = insertFact(CHAT, 'orphan check text', 'regression', 'semantic')
    // Row present in FTS before delete
    const beforeRows = getDb()
      .prepare('SELECT rowid FROM facts_fts WHERE rowid = ?')
      .all(id) as unknown as { rowid: number }[]
    expect(beforeRows.length).toBe(1)
    expect(deleteFact(id, CHAT)).toBe(true)
    // No orphan row in facts_fts after delete
    const afterRows = getDb()
      .prepare('SELECT rowid FROM facts_fts WHERE rowid = ?')
      .all(id) as unknown as { rowid: number }[]
    expect(afterRows.length).toBe(0)
    // No error logged
    const ftsErrors = errorSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === 'string' && call[1].toLowerCase().includes('fts')
    )
    expect(ftsErrors).toEqual([])
  })

  // Regression: updateFact used to silently fail FTS sync, leaving the
  // stale content searchable and the new content invisible to searchFacts.
  it('updateFact reindexes FTS so new content is searchable', () => {
    const id = insertFact(CHAT, 'original banana content', 'fruit', 'semantic')
    // Old content is searchable
    expect(searchFacts(CHAT, 'banana').some(f => f.id === id)).toBe(true)

    expect(updateFact(id, CHAT, 'updated mango content')).toBe(true)

    // Old term is no longer searchable
    expect(searchFacts(CHAT, 'banana').some(f => f.id === id)).toBe(false)
    // New term IS searchable
    expect(searchFacts(CHAT, 'mango').some(f => f.id === id)).toBe(true)
  })

  // Sanity: searchFacts must not return orphaned rows even if the FTS
  // is momentarily out of sync. The INNER JOIN in searchFacts already
  // guards against this — this test locks that invariant in.
  it('searchFacts ignores orphan FTS rows', () => {
    const id = insertFact(CHAT, 'orphan phantom term', 'test', 'episodic')
    // Delete only from facts, simulate stale FTS
    getDb().prepare('DELETE FROM facts WHERE id = ?').run(id)
    const results = searchFacts(CHAT, 'phantom')
    expect(results.find(f => f.id === id)).toBeUndefined()
    // Cleanup orphan for other tests
    try { getDb().prepare('DELETE FROM facts_fts WHERE rowid = ?').run(id) } catch { /* ok */ }
  })
})

describe('chat settings', () => {
  it('returns undefined for missing key', () => {
    expect(getChatSetting(CHAT, 'nonexistent')).toBeUndefined()
  })

  it('set and get roundtrip', () => {
    setChatSetting(CHAT, 'theme', 'dark')
    expect(getChatSetting(CHAT, 'theme')).toBe('dark')
  })

  it('upsert overwrites', () => {
    setChatSetting(CHAT, 'lang', 'en')
    setChatSetting(CHAT, 'lang', 'uk')
    expect(getChatSetting(CHAT, 'lang')).toBe('uk')
  })

  it('delete removes setting', () => {
    setChatSetting(CHAT, 'tmp', 'val')
    deleteChatSetting(CHAT, 'tmp')
    expect(getChatSetting(CHAT, 'tmp')).toBeUndefined()
  })
})

describe('approved groups', () => {
  it('returns empty array initially', () => {
    expect(getApprovedGroups()).toEqual([])
  })

  it('addApprovedGroup adds a group', () => {
    addApprovedGroup('-100123')
    expect(getApprovedGroups()).toEqual(['-100123'])
  })

  it('addApprovedGroup is idempotent', () => {
    addApprovedGroup('-100123')
    expect(getApprovedGroups()).toEqual(['-100123'])
  })

  it('addApprovedGroup adds multiple groups', () => {
    addApprovedGroup('-100456')
    expect(getApprovedGroups()).toEqual(['-100123', '-100456'])
  })

  it('removeApprovedGroup removes a group', () => {
    removeApprovedGroup('-100123')
    expect(getApprovedGroups()).toEqual(['-100456'])
  })

  it('removeApprovedGroup cleans up when last group removed', () => {
    removeApprovedGroup('-100456')
    expect(getApprovedGroups()).toEqual([])
    expect(getChatSetting('_global', 'allowed_groups')).toBeUndefined()
  })

  it('removeApprovedGroup is safe for non-existent group', () => {
    removeApprovedGroup('-999')
    expect(getApprovedGroups()).toEqual([])
  })
})

describe('content hash dedup', () => {
  it('computeFactHash is deterministic', () => {
    const h1 = computeFactHash('Hello world', 'test', 'semantic')
    const h2 = computeFactHash('Hello world', 'test', 'semantic')
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(16)
  })

  it('computeFactHash normalizes whitespace and case', () => {
    const h1 = computeFactHash('Hello  World', 'test', 'semantic')
    const h2 = computeFactHash('hello world', 'test', 'semantic')
    expect(h1).toBe(h2)
  })

  it('computeFactHash differs by topic', () => {
    const h1 = computeFactHash('Same content', 'health', 'semantic')
    const h2 = computeFactHash('Same content', 'work', 'semantic')
    expect(h1).not.toBe(h2)
  })

  it('insertFact returns -1 for exact duplicate', () => {
    const chat = 'dedup-chat'
    const id1 = insertFact(chat, 'Unique fact for dedup test', 'test', 'semantic')
    expect(id1).toBeGreaterThan(0)
    const id2 = insertFact(chat, 'Unique fact for dedup test', 'test', 'semantic')
    expect(id2).toBe(-1)
  })

  it('insertFactsBatch skips duplicates with -1', () => {
    const chat = 'dedup-batch-chat'
    const facts = [
      { content: 'Batch fact A', topic: 'test', tags: '', sector: 'semantic' as const, importance: 0.5 },
      { content: 'Batch fact B', topic: 'test', tags: '', sector: 'semantic' as const, importance: 0.5 },
      { content: 'Batch fact A', topic: 'test', tags: '', sector: 'semantic' as const, importance: 0.5 }, // dup
    ]
    const ids = insertFactsBatch(chat, facts)
    expect(ids[0]).toBeGreaterThan(0)
    expect(ids[1]).toBeGreaterThan(0)
    expect(ids[2]).toBe(-1) // duplicate
  })
})

describe('bumpFactUsefulness', () => {
  it('increments usefulness for given ids', () => {
    const chat = 'usefulness-chat'
    const id = insertFact(chat, 'Useful fact test', 'test', 'semantic')
    expect(id).toBeGreaterThan(0)
    bumpFactUsefulness([id], 0.1)
    const row = getDb().prepare('SELECT usefulness FROM facts WHERE id = ?').get(id) as { usefulness: number }
    expect(row.usefulness).toBeCloseTo(0.1, 2)
  })

  it('caps usefulness at 2.0', () => {
    const chat = 'usefulness-cap-chat'
    const id = insertFact(chat, 'Cap test fact', 'test', 'semantic')
    expect(id).toBeGreaterThan(0)
    bumpFactUsefulness([id], 1.5)
    bumpFactUsefulness([id], 1.5)
    const row = getDb().prepare('SELECT usefulness FROM facts WHERE id = ?').get(id) as { usefulness: number }
    expect(row.usefulness).toBe(2.0)
  })

  it('handles empty ids gracefully', () => {
    expect(() => bumpFactUsefulness([])).not.toThrow()
  })
})

