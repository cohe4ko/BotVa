import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---

const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-agent-test-'))
})

vi.mock('./config.js', () => ({
  BOT_DIR: testDir,
  BOT_NAME: 'test-bot',
  PROJECT_ROOT: testDir,
  TYPING_REFRESH_MS: 4000,
  AGENT_WATCHDOG_WARN_SECONDS: 60,
  AGENT_WATCHDOG_TIMEOUT_MS: 600000,
}))

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('./model.js', () => ({
  parseModelConfig: vi.fn((m: string) => ({ model: m })),
}))

vi.mock('./mcp-config.js', () => ({
  buildMcpServers: vi.fn(async () => ({})),
}))

vi.mock('./workspace-files.js', () => ({
  refreshClaudeMd: vi.fn(),
}))

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}))

vi.mock('./team.js', () => ({
  isManager: vi.fn(() => false),
}))

const mockClearSession = vi.fn()
vi.mock('./db.js', () => ({
  clearSession: mockClearSession,
}))

vi.mock('./agent-watchdog.js', () => ({
  AgentWatchdog: class {
    start = vi.fn()
    stop = vi.fn()
    recordActivity = vi.fn()
  },
}))

vi.mock('./disk-sessions.js', () => ({
  getClaudeProjectDir: vi.fn(() => testDir),
}))

const mockAbortController = { abort: vi.fn(), signal: { aborted: false } }
const mockIsCancelled = vi.fn(() => false)
const mockIsInterrupted = vi.fn(() => false)
vi.mock('./request-queue.js', () => ({
  createAbortController: vi.fn(() => mockAbortController),
  setActiveQuery: vi.fn(),
  clearActiveQuery: vi.fn(),
  isCancelled: (...args: unknown[]) => (mockIsCancelled as Function)(...args),
  isInterrupted: (...args: unknown[]) => (mockIsInterrupted as Function)(...args),
}))

// Mock the SDK query function — yields events in sequence
const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => (mockQuery as Function)(...args),
}))

import { runAgent } from './agent.js'
import { writeFileSync } from 'fs'
import { join } from 'path'

// Helper: create a fake session file so validateSessionFile returns true
function createFakeSession(sessionId: string): void {
  writeFileSync(join(testDir, `${sessionId}.jsonl`), '{"type":"system"}\n')
}

// Helper: create async generator from events
async function* eventStream(events: any[]) {
  for (const e of events) yield e
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsCancelled.mockReturnValue(false)
  mockIsInterrupted.mockReturnValue(false)
})

// --- Tests ---

describe('runAgent', () => {
  describe('event handling', () => {
    it('returns result text on success', async () => {
      mockQuery.mockReturnValue(eventStream([
        { type: 'system', subtype: 'init', session_id: 'sess-123' },
        { type: 'result', subtype: 'success', result: 'Hello!', modelUsage: { 'claude-sonnet': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000, costUSD: 0.01 } } },
      ]))

      const res = await runAgent('test', undefined, undefined, 'chat1')
      expect(res.text).toBe('Hello!')
      expect(res.newSessionId).toBe('sess-123')
    })

    it('returns error text on result error', async () => {
      mockQuery.mockReturnValue(eventStream([
        { type: 'result', subtype: 'error', errors: ['Something went wrong'], modelUsage: {} },
      ]))

      const res = await runAgent('test', undefined, undefined, 'chat1')
      expect(res.text).toBe('Something went wrong')
    })

    it('collects usage stats from modelUsage', async () => {
      mockQuery.mockReturnValue(eventStream([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
          },
        },
        {
          type: 'result', subtype: 'success', result: 'Done',
          modelUsage: {
            'claude-sonnet': { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 200, cacheCreationInputTokens: 50, contextWindow: 200000, costUSD: 0.05 },
          },
        },
      ]))

      const res = await runAgent('test', undefined, undefined, 'chat1')
      expect(res.usage).toBeDefined()
      expect(res.usage!.inputTokens).toBe(500)
      expect(res.usage!.outputTokens).toBe(100)
      expect(res.usage!.costUSD).toBe(0.05)
      expect(res.usage!.lastTurnContextTokens).toBe(750) // 500 + 200 + 50
    })

    it('collects assistant text blocks', async () => {
      mockQuery.mockReturnValue(eventStream([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Part 1' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Part 2' }] } },
        { type: 'result', subtype: 'success', result: 'Final', modelUsage: {} },
      ]))

      const res = await runAgent('test', undefined, undefined, 'chat1')
      expect(res.text).toBe('Final')
    })
  })

  describe('error classification', () => {
    it('returns cancel text on hard cancel', async () => {
      mockIsCancelled.mockReturnValue(true)
      mockQuery.mockReturnValue(eventStream([
        { type: 'result', subtype: 'success', result: 'Should be ignored', modelUsage: {} },
      ]))

      const res = await runAgent('test', undefined, undefined, 'chat1')
      expect(res.text).toBe('(запит скасовано)')
    })

    it('returns partial text on soft interrupt (via catch)', async () => {
      mockIsInterrupted.mockReturnValue(true)
      mockQuery.mockImplementation(async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial result' }] } }
        throw new Error('Request was aborted')
      })

      const res = await runAgent('test', undefined, undefined, 'chat1')
      expect(res.text).toBe('Partial result')
    })

    it('returns cancel text on abort without interrupt', async () => {
      mockIsCancelled.mockReturnValue(true)
      mockQuery.mockImplementation(async function* () {
        throw new Error('Request was aborted')
      })

      const res = await runAgent('test', undefined, undefined, 'chat1')
      expect(res.text).toBe('(запит скасовано)')
    })

    it('returns crash template on process crash without session', async () => {
      mockQuery.mockImplementation(async function* () {
        throw new Error('exited with code 1')
      })

      const res = await runAgent('test', undefined, undefined, 'chat1')
      expect(res.text).toBe('{{agent.crash}}')
    })

    it('returns crash partial when process crash has prior text', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Some work done' }] } }
        throw new Error('terminated process')
      })

      const res = await runAgent('test', undefined, undefined, 'chat1')
      expect(res.text).toContain('Some work done')
      expect(res.text).toContain('{{agent.crash.partial}}')
    })

    it('returns generic error for unknown errors', async () => {
      mockQuery.mockImplementation(async function* () {
        throw new Error('Connection timeout')
      })

      const res = await runAgent('test', undefined, undefined, 'chat1')
      expect(res.text).toContain('{{agent.error}}')
      expect(res.text).toContain('Connection timeout')
    })
  })

  describe('retry logic', () => {
    it('retries without session on process crash with session', async () => {
      createFakeSession('existing-session')
      let callCount = 0
      mockQuery.mockImplementation(async function* () {
        callCount++
        if (callCount === 1) {
          yield { type: 'system', subtype: 'init', session_id: 'sess-old' }
          throw new Error('exited with code 1')
        }
        yield { type: 'system', subtype: 'init', session_id: 'sess-new' }
        yield { type: 'result', subtype: 'success', result: 'Recovered', modelUsage: {} }
      })

      const res = await runAgent('test', 'existing-session', undefined, 'chat1')
      expect(res.text).toBe('Recovered')
      expect(mockClearSession).toHaveBeenCalledWith('chat1')
    })

    it('returns double crash when retry returns no text', async () => {
      createFakeSession('existing-session')
      let callCount = 0
      mockIsInterrupted.mockReturnValue(false)
      mockIsCancelled.mockReturnValue(false)
      mockQuery.mockImplementation(async function* () {
        callCount++
        if (callCount === 1) {
          // First call: crash with session → sessionFailed
          throw new Error('exited with code 1')
        }
        // Second call: yield nothing, return no text (simulating empty result)
        yield { type: 'result', subtype: 'error', errors: undefined, modelUsage: {} }
      })

      const res = await runAgent('test', 'existing-session', undefined, 'chat1')
      // Retry returned 'Error occurred' (fallback for missing errors), not null
      expect(res.text).toBe('Error occurred')
    })

    it('returns crash template when retry also crashes without session', async () => {
      createFakeSession('existing-session')
      mockQuery.mockImplementation(async function* () {
        throw new Error('exited with code 1')
      })

      const res = await runAgent('test', 'existing-session', undefined, 'chat1')
      // First call sessionFailed → retry without session → crash template
      expect(res.text).toBe('{{agent.crash}}')
    })
  })

  describe('refreshClaudeMd', () => {
    it('refreshes CLAUDE.md before running agent', async () => {
      const { refreshClaudeMd } = await import('./workspace-files.js')
      mockQuery.mockReturnValue(eventStream([
        { type: 'result', subtype: 'success', result: 'ok', modelUsage: {} },
      ]))

      await runAgent('test', undefined, undefined, 'chat1')
      expect(refreshClaudeMd).toHaveBeenCalledWith(testDir)
    })
  })

  describe('rewind anchor (resumeSessionAt)', () => {
    const okStream = () => eventStream([
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'result', subtype: 'success', result: 'ok', modelUsage: {} },
    ])

    it('passes resumeSessionAt when a session + anchor are provided', async () => {
      createFakeSession('sess-anchor')
      mockQuery.mockReturnValue(okStream())
      await runAgent('test', 'sess-anchor', undefined, 'chat1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'anchor-uuid')
      const opts = mockQuery.mock.calls[0][0].options
      expect(opts.resume).toBe('sess-anchor')
      expect(opts.resumeSessionAt).toBe('anchor-uuid')
    })

    it('omits resumeSessionAt when no anchor is given', async () => {
      createFakeSession('sess-plain')
      mockQuery.mockReturnValue(okStream())
      await runAgent('test', 'sess-plain', undefined, 'chat1')
      const opts = mockQuery.mock.calls[0][0].options
      expect(opts.resumeSessionAt).toBeUndefined()
    })

    it('omits resumeSessionAt when there is no session (fresh start)', async () => {
      mockQuery.mockReturnValue(okStream())
      await runAgent('test', undefined, undefined, 'chat1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'anchor-uuid')
      const opts = mockQuery.mock.calls[0][0].options
      expect(opts.resumeSessionAt).toBeUndefined()
    })
  })

})
