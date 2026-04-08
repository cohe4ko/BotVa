import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---

vi.mock('./config.js', () => ({
  BOT_DIR: '/tmp/bot',
  BOT_NAME: 'testbot',
  ALLOWED_CHAT_ID: '1',
}))

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('./agent.js', () => ({
  runAgent: vi.fn(async () => ({ text: 'ok' })),
}))

vi.mock('./model.js', () => ({
  getBackgroundModel: vi.fn(() => 'sonnet'),
}))

vi.mock('./builtin-tools.js', () => ({
  createConsolidationMcpServer: vi.fn(() => ({ server: {} })),
}))

vi.mock('./memory.js', () => ({
  memoryDate: () => '2026-01-01',
}))

vi.mock('./consolidation-queue.js', () => ({
  enqueue: vi.fn(),
  dequeueAll: vi.fn(() => []),
  markDone: vi.fn(),
  markFailed: vi.fn(),
}))

vi.mock('./session-compactor.js', () => ({
  compactSessionJsonl: vi.fn(() => null),
  compactJsonlContent: vi.fn(() => ({
    turns: [],
    stats: { totalTurns: 0, toolCalls: 0, rawBytes: 0, compactedBytes: 0, trivial: true },
  })),
}))

// Dynamic-imported deps
const listAllSessionsMock = vi.fn()
vi.mock('./db.js', () => ({
  listAllSessions: listAllSessionsMock,
  isSessionConsolidated: vi.fn(() => false),
  markSessionConsolidated: vi.fn(),
  getMidSessionOffset: vi.fn(() => 0),
  setMidSessionOffset: vi.fn(),
}))

const getClaudeProjectDirMock = vi.fn(() => '/tmp/nonexistent-project')
vi.mock('./disk-sessions.js', () => ({
  getClaudeProjectDir: getClaudeProjectDirMock,
}))

// fs: make every jsonl path "not exist" so consolidateSession early-returns.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ size: 0 })),
    readFileSync: vi.fn(() => ''),
  }
})

import { runActiveSessionSweep } from './consolidate.js'

describe('runActiveSessionSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns zero stats when no sessions exist', async () => {
    listAllSessionsMock.mockReturnValue([])
    const stats = await runActiveSessionSweep()
    expect(stats).toEqual({ total: 0, processed: 0, skipped: 0, failed: 0 })
  })

  it('iterates all sessions from listAllSessions', async () => {
    listAllSessionsMock.mockReturnValue([
      { chatId: '111', sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      { chatId: '222', sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      { chatId: '333', sessionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
    ])
    const stats = await runActiveSessionSweep()
    expect(stats.total).toBe(3)
    // Files don't exist → all skipped via fast-path in consolidateSession
    expect(stats.skipped).toBe(3)
    expect(stats.processed).toBe(0)
    expect(stats.failed).toBe(0)
  })

  it('continues sweep when one item throws', async () => {
    // First call to getClaudeProjectDir throws, second and third succeed
    let callCount = 0
    getClaudeProjectDirMock.mockImplementation(() => {
      callCount++
      if (callCount === 1) throw new Error('boom')
      return '/tmp/nonexistent-project'
    })

    listAllSessionsMock.mockReturnValue([
      { chatId: '111', sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      { chatId: '222', sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      { chatId: '333', sessionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
    ])

    const stats = await runActiveSessionSweep()
    expect(stats.total).toBe(3)
    expect(stats.failed).toBe(1)
    // The other two still processed (fast-path skip)
    expect(stats.failed + stats.processed + stats.skipped).toBe(3)
  })
})
