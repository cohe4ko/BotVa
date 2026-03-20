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
  searchFacts,
  deleteFact,
  getChatSetting,
  setChatSetting,
  deleteChatSetting,
  getApprovedGroups,
  addApprovedGroup,
  removeApprovedGroup,
} from './db.js'

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

