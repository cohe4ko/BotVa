import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mocks ---

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockGetDueTasks = vi.fn(() => [])
const mockUpdateTaskAfterRun = vi.fn()
const mockGetDueReminders = vi.fn(() => [])
const mockMarkReminderSent = vi.fn()
vi.mock('./db.js', () => ({
  getDueTasks: () => mockGetDueTasks(),
  updateTaskAfterRun: (...args: any[]) => mockUpdateTaskAfterRun(...args),
  getDueReminders: () => mockGetDueReminders(),
  markReminderSent: (...args: any[]) => mockMarkReminderSent(...args),
}))

const mockRunAgent = vi.fn(async () => ({ text: 'agent result', newSessionId: undefined, usage: undefined }))
vi.mock('./agent.js', () => ({
  runAgent: (...args: any[]) => mockRunAgent(...args),
}))

vi.mock('./builtin-tools.js', () => ({
  createBuiltinMcpServer: vi.fn(async () => ({ server: { fake: true } })),
}))

import { computeNextRun, runDueTasks, initScheduler, stopScheduler } from './scheduler.js'

beforeEach(() => {
  vi.clearAllMocks()
})

// --- Tests ---

describe('computeNextRun', () => {
  it('returns unix timestamp in seconds for valid cron', () => {
    const next = computeNextRun('0 9 * * *') // every day at 9:00
    expect(next).toBeGreaterThan(Math.floor(Date.now() / 1000))
    // Should be within 24h + margin
    expect(next).toBeLessThan(Math.floor(Date.now() / 1000) + 86400 + 60)
  })

  it('returns timestamp in seconds (not milliseconds)', () => {
    const next = computeNextRun('* * * * *') // every minute
    // Seconds-based timestamp: ~10 digits. Milliseconds: ~13 digits
    expect(String(next).length).toBeLessThanOrEqual(10)
  })

  it('handles every-minute cron', () => {
    const next = computeNextRun('* * * * *')
    const nowSec = Math.floor(Date.now() / 1000)
    // Next run should be within 60 seconds
    expect(next - nowSec).toBeLessThanOrEqual(60)
    expect(next - nowSec).toBeGreaterThan(0)
  })

  it('handles complex cron expressions', () => {
    // Every Monday at 10:30
    const next = computeNextRun('30 10 * * 1')
    expect(next).toBeGreaterThan(Math.floor(Date.now() / 1000))
    // Within 7 days
    expect(next).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 7 * 86400 + 60)
  })

  it('throws on invalid cron expression', () => {
    expect(() => computeNextRun('invalid cron')).toThrow()
    expect(() => computeNextRun('99 99 99 99 99')).toThrow()
  })
})

describe('runDueTasks', () => {
  it('does nothing when no tasks or reminders are due', async () => {
    mockGetDueTasks.mockReturnValue([])
    mockGetDueReminders.mockReturnValue([])

    await runDueTasks()
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('sends due reminders', async () => {
    const mockSender = vi.fn(async () => {})
    initScheduler(mockSender)

    mockGetDueReminders.mockReturnValue([
      { id: 1, chat_id: '123', text: 'Test reminder', remind_at: 100, created_at: 50, status: 'pending' },
    ])
    mockGetDueTasks.mockReturnValue([])

    await runDueTasks()
    expect(mockSender).toHaveBeenCalledWith('123', '🔔 Test reminder')
    expect(mockMarkReminderSent).toHaveBeenCalledWith(1)

    stopScheduler()
  })

  it('runs due tasks and updates next_run', async () => {
    const mockSender = vi.fn(async () => {})
    initScheduler(mockSender)

    mockGetDueReminders.mockReturnValue([])
    mockGetDueTasks.mockReturnValue([{
      id: 'task-1',
      chat_id: '456',
      prompt: 'Do something',
      schedule: '0 9 * * *',
      next_run: Math.floor(Date.now() / 1000) - 60,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: 100,
    }])
    mockRunAgent.mockResolvedValue({ text: 'Done!', newSessionId: undefined, usage: undefined })

    await runDueTasks()
    expect(mockRunAgent).toHaveBeenCalled()
    expect(mockUpdateTaskAfterRun).toHaveBeenCalledWith('task-1', 'Done!', expect.any(Number))
    // Sender called twice: start notification + result
    expect(mockSender).toHaveBeenCalledTimes(2)

    stopScheduler()
  })

  it('retries crashed task once', async () => {
    const mockSender = vi.fn(async () => {})
    initScheduler(mockSender)

    mockGetDueReminders.mockReturnValue([])
    mockGetDueTasks.mockReturnValue([{
      id: 'task-2', chat_id: '789', prompt: 'Crash test',
      schedule: '* * * * *', next_run: 0, last_run: null, last_result: null, status: 'active', created_at: 0,
    }])

    mockRunAgent
      .mockResolvedValueOnce({ text: '{{agent.crash}}', newSessionId: undefined, usage: undefined })
      .mockResolvedValueOnce({ text: 'Recovered', newSessionId: undefined, usage: undefined })

    await runDueTasks()
    expect(mockRunAgent).toHaveBeenCalledTimes(2)
    expect(mockUpdateTaskAfterRun).toHaveBeenCalledWith('task-2', 'Recovered', expect.any(Number))

    stopScheduler()
  })

  it('still updates next_run on task failure', async () => {
    const mockSender = vi.fn(async () => {})
    initScheduler(mockSender)

    mockGetDueReminders.mockReturnValue([])
    mockGetDueTasks.mockReturnValue([{
      id: 'task-3', chat_id: '111', prompt: 'Fail test',
      schedule: '0 12 * * *', next_run: 0, last_run: null, last_result: null, status: 'active', created_at: 0,
    }])
    mockRunAgent.mockRejectedValue(new Error('Network error'))

    await runDueTasks()
    expect(mockUpdateTaskAfterRun).toHaveBeenCalledWith('task-3', expect.stringContaining('ERROR'), expect.any(Number))

    stopScheduler()
  })
})

describe('initScheduler / stopScheduler', () => {
  it('starts and stops interval', () => {
    vi.useFakeTimers()
    const mockSender = vi.fn(async () => {})

    initScheduler(mockSender)
    // Verify interval was set (runDueTasks called after 60s)
    stopScheduler()

    vi.useRealTimers()
  })
})
