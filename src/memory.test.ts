import { describe, it, expect, vi } from 'vitest'

// Mock config to avoid reading .env
vi.mock('./config.js', () => ({
  NIGHT_OWL_HOUR: 4,
  BOT_DIR: '/tmp/test-bot',
  BOT_NAME: 'TestBot',
  USER_PREVIEW_LEN: 200,
  ASSISTANT_PREVIEW_LEN: 200,
  MIN_MSG_LEN_TO_SAVE: 5,
  MIN_ASSISTANT_LEN_TO_SAVE: 5,
  MAX_ASSISTANT_MEMORY_LEN: 500,
}))

vi.mock('./db.js', () => ({
  insertMemory: vi.fn(),
  decayAndPruneMemories: vi.fn(),
}))

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { memoryDate } from './memory.js'

describe('memoryDate', () => {
  it('15:00 returns today', () => {
    const date = new Date('2025-06-15T15:00:00')
    expect(memoryDate(date)).toBe('2025-06-15')
  })

  it('03:59 returns yesterday (night-owl)', () => {
    const date = new Date('2025-06-15T03:59:00')
    expect(memoryDate(date)).toBe('2025-06-14')
  })

  it('04:00 returns today', () => {
    const date = new Date('2025-06-15T04:00:00')
    expect(memoryDate(date)).toBe('2025-06-15')
  })

  it('00:00 returns yesterday', () => {
    const date = new Date('2025-06-15T00:00:00')
    expect(memoryDate(date)).toBe('2025-06-14')
  })

  it('month boundary: March 1 at 03:00 returns Feb 28', () => {
    // 2025 is not a leap year
    const date = new Date('2025-03-01T03:00:00')
    expect(memoryDate(date)).toBe('2025-02-28')
  })
})
