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
  SANDBOX_ENABLED: false,
  BACKGROUND_TASK_MAX_MS: 1800000,
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
  clearInterrupted: vi.fn(),
  setLiveRun: (key: string, run: { push(text: string): boolean }) => { liveRuns.set(key, run) },
  setBackgroundTasks: vi.fn(),
}))
const liveRuns = vi.hoisted(() => new Map<string, { push(text: string): boolean }>())

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

  describe('ask mode canUseTool', () => {
    const okStream = () => eventStream([
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'result', subtype: 'success', result: 'ok', modelUsage: {} },
    ])

    it('non-ask mode uses bypassPermissions and no canUseTool', async () => {
      mockQuery.mockReturnValue(okStream())
      await runAgent('test', undefined, undefined, 'chat1')
      const opts = mockQuery.mock.calls[0][0].options
      expect(opts.permissionMode).toBe('bypassPermissions')
      expect(opts.allowDangerouslySkipPermissions).toBe(true)
      expect(opts.canUseTool).toBeUndefined()
    })

    it('ask mode uses permissionMode default + canUseTool, no bypass flag', async () => {
      mockQuery.mockReturnValue(okStream())
      const onPerm = vi.fn(async () => true)
      await runAgent('test', undefined, undefined, 'chat1', undefined, undefined, undefined, undefined, onPerm)
      const opts = mockQuery.mock.calls[0][0].options
      expect(opts.permissionMode).toBe('default')
      expect(opts.allowDangerouslySkipPermissions).toBeUndefined()
      expect(typeof opts.canUseTool).toBe('function')
    })

    it('canUseTool auto-approves read-only tools without prompting', async () => {
      mockQuery.mockReturnValue(okStream())
      const onPerm = vi.fn(async () => false)
      await runAgent('test', undefined, undefined, 'chat1', undefined, undefined, undefined, undefined, onPerm)
      const canUseTool = mockQuery.mock.calls[0][0].options.canUseTool
      const res = await canUseTool('Read', { file_path: '/x' }, { agentID: undefined })
      expect(res.behavior).toBe('allow')
      expect(onPerm).not.toHaveBeenCalled()
    })

    it('canUseTool bridges dangerous tools to onPermissionRequest (deny)', async () => {
      mockQuery.mockReturnValue(okStream())
      const onPerm = vi.fn(async () => false)
      await runAgent('test', undefined, undefined, 'chat1', undefined, undefined, undefined, undefined, onPerm)
      const canUseTool = mockQuery.mock.calls[0][0].options.canUseTool
      const res = await canUseTool('Bash', { command: 'rm -rf /' }, {})
      expect(res.behavior).toBe('deny')
      expect(res.message).toBe('Denied by user')
      expect(onPerm).toHaveBeenCalledWith('Bash', expect.stringContaining('bash: rm -rf'))
    })

    it('canUseTool prefixes subagent requests with (субагент)', async () => {
      mockQuery.mockReturnValue(okStream())
      const onPerm = vi.fn(async () => true)
      await runAgent('test', undefined, undefined, 'chat1', undefined, undefined, undefined, undefined, onPerm)
      const canUseTool = mockQuery.mock.calls[0][0].options.canUseTool
      const res = await canUseTool('Write', { file_path: '/f' }, { agentID: 'agent-7' })
      expect(res.behavior).toBe('allow')
      expect(onPerm).toHaveBeenCalledWith('(субагент) Write', expect.stringContaining('/f'))
    })

    it('plan mode still uses bypassPermissions with PreToolUse hooks (no canUseTool)', async () => {
      mockQuery.mockReturnValue(okStream())
      await runAgent('test', undefined, undefined, 'chat1', undefined, undefined, undefined, 'plan')
      const opts = mockQuery.mock.calls[0][0].options
      expect(opts.permissionMode).toBe('bypassPermissions')
      expect(opts.canUseTool).toBeUndefined()
      expect(opts.hooks?.PreToolUse).toBeDefined()
    })

    it('does not pass a sandbox option when SANDBOX_ENABLED is off (default)', async () => {
      mockQuery.mockReturnValue(okStream())
      await runAgent('test', undefined, undefined, 'chat1')
      const opts = mockQuery.mock.calls[0][0].options
      expect('sandbox' in opts).toBe(false)
    })
  })

})

// --- Streaming input ---

const usageOf = (cost: number) => ({ m: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000, costUSD: cost } })
const textOf = (m: any) => typeof m.message.content === 'string' ? m.message.content : ''

/**
 * A fake query that reads its streaming input like the CLI does: one turn
 * per user message, a result after each, and it ends when the input ends.
 */
function liveQuery(onMessage: (text: string, n: number) => any[]) {
  mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<any> }) => (async function* () {
    let n = 0
    for await (const m of prompt) {
      n++
      for (const e of onMessage(textOf(m), n)) yield e
    }
  })())
}

describe('runAgent streaming input', () => {
  it('passes an async iterable, not a string, and ends after the only turn', async () => {
    liveQuery((text) => [{ type: 'result', subtype: 'success', result: `echo ${text}`, modelUsage: usageOf(0.01) }])
    const res = await runAgent('hello', undefined, undefined, 'live1')
    expect(typeof mockQuery.mock.calls[0][0].prompt).not.toBe('string')
    expect(mockQuery.mock.calls[0][0].options.perTaskStopAffordance).toBe(true)
    expect(res.text).toBe('echo hello')
  })

  it('a follow-up pushed during a turn reaches the same run, formatted, and is answered', async () => {
    const delivered: (string | null)[] = []
    const followups: string[] = []
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<any> }) => (async function* () {
      const it = prompt[Symbol.asyncIterator]()
      const first = await it.next()
      // The user writes while the first turn is still running
      expect(liveRuns.get('live2')!.push('also this')).toBe(true)
      yield { type: 'result', subtype: 'success', result: `A:${textOf(first.value)}`, modelUsage: usageOf(0.01) }
      const second = await it.next()
      yield { type: 'result', subtype: 'success', result: `B:${textOf(second.value)}`, modelUsage: usageOf(0.03) }
      expect((await it.next()).done).toBe(true)
    })())
    const res = await runAgent('task', undefined, undefined, 'live2', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      formatFollowup: (t) => `[follow-up] ${t}`,
      onFollowup: (t) => followups.push(t),
      onTurnResult: async (r) => { delivered.push(r.text) },
    })
    expect(followups).toEqual(['also this'])
    expect(delivered).toEqual(['A:task', 'B:[follow-up] also this'])
    expect(res.text).toBe('B:[follow-up] also this')
  })

  it('reports each turn its own share of the cumulative usage', async () => {
    const costs: number[] = []
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<any> }) => (async function* () {
      const it = prompt[Symbol.asyncIterator]()
      await it.next()
      liveRuns.get('live3')!.push('more')
      yield { type: 'result', subtype: 'success', result: 'one', modelUsage: usageOf(0.01) }
      await it.next()
      yield { type: 'result', subtype: 'success', result: 'two', modelUsage: usageOf(0.04) }
    })())
    await runAgent('x', undefined, undefined, 'live3', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      onTurnResult: async (r) => { costs.push(Number(r.usage!.costUSD.toFixed(2))) },
    })
    expect(costs).toEqual([0.01, 0.03])
  })

  it('keeps the input open while a background task runs and closes after it reports back', async () => {
    vi.useFakeTimers()
    try {
      const delivered: (string | null)[] = []
      let inputDone = false
      mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<any> }) => (async function* () {
        const it = prompt[Symbol.asyncIterator]()
        await it.next()
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'build' }] }
        yield { type: 'result', subtype: 'success', result: 'started in background', modelUsage: usageOf(0.01) }
        // The input must still be open: nothing more arrives, but it does not end
        const pending = it.next().then(r => { inputDone = !!r.done })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(inputDone).toBe(false)
        // The task finishes and the model reports on it in a turn of its own
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] }
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'done' }] } }
        yield { type: 'result', subtype: 'success', result: 'build finished', modelUsage: usageOf(0.02) }
        await pending
        expect(inputDone).toBe(true)
      })())
      await runAgent('build it', undefined, undefined, 'live4', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
        onTurnResult: async (r) => { delivered.push(r.text) },
      })
      expect(delivered).toEqual(['started in background', 'build finished'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a follow-up after the input closed is refused, so the caller keeps it', async () => {
    liveQuery(() => [{ type: 'result', subtype: 'success', result: 'ok', modelUsage: usageOf(0.01) }])
    await runAgent('hi', undefined, undefined, 'live5')
    expect(liveRuns.get('live5')!.push('late')).toBe(false)
  })
})

describe('validateSessionFile', () => {
  it('accepts a session whose first line is a long queue-operation entry', async () => {
    const { validateSessionFile } = await import('./agent.js')
    const long = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'x'.repeat(12_000) })
    writeFileSync(join(testDir, 'long-first.jsonl'), `${long}\n{"type":"user"}\n`)
    expect(validateSessionFile('long-first')).toBe(true)
  })

  it('accepts a first line longer than the bytes it reads, if it starts as JSON', async () => {
    const { validateSessionFile } = await import('./agent.js')
    writeFileSync(join(testDir, 'huge-first.jsonl'), `{"type":"queue-operation","content":"${'y'.repeat(100_000)}"}\n`)
    expect(validateSessionFile('huge-first')).toBe(true)
  })

  it('rejects a missing, empty or garbled file', async () => {
    const { validateSessionFile } = await import('./agent.js')
    expect(validateSessionFile('no-such')).toBe(false)
    writeFileSync(join(testDir, 'empty.jsonl'), '')
    expect(validateSessionFile('empty')).toBe(false)
    writeFileSync(join(testDir, 'garbled.jsonl'), 'not json\n')
    expect(validateSessionFile('garbled')).toBe(false)
  })
})
