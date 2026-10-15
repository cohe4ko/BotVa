import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  throttled, parseFloodWait, typingDelayMs, getThrottleStats, resetThrottle,
  FloodWaitError, configureThrottle, configureThrottlePersistence,
  countUnpacedCall, topLabels,
} from './throttle.js'

beforeEach(() => {
  resetThrottle()
})

describe('parseFloodWait', () => {
  it('reads the penalty out of the error text', () => {
    expect(parseFloodWait(new Error('A wait of 42 seconds is required (FLOOD_WAIT)'))).toBe(42)
    expect(parseFloodWait(new Error('FLOOD_WAIT_120'))).toBe(120)
  })

  it('defaults to a cautious value when the text has no number', () => {
    expect(parseFloodWait(new Error('FLOOD_WAIT'))).toBe(60)
  })

  it('returns null for unrelated errors', () => {
    expect(parseFloodWait(new Error('CHAT_ID_INVALID'))).toBeNull()
    expect(parseFloodWait('timeout')).toBeNull()
  })
})

describe('pacing', () => {
  it('spaces consecutive calls instead of firing them back to back', async () => {
    const at: number[] = []
    const stamp = async () => { at.push(Date.now()); return 1 }

    await throttled('a', stamp)
    await throttled('b', stamp)

    // MIN_INTERVAL_MS is 700; allow slack for timer coarseness.
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(650)
  }, 10000)

  it('serialises concurrent callers rather than letting them race', async () => {
    const order: string[] = []
    const task = (name: string) => async () => {
      order.push(`start:${name}`)
      await new Promise(r => setTimeout(r, 10))
      order.push(`end:${name}`)
      return name
    }

    await Promise.all([
      throttled('a', task('a')),
      throttled('b', task('b')),
      throttled('c', task('c')),
    ])

    // No interleaving: each call finishes before the next begins.
    expect(order).toEqual([
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c',
    ])
  }, 15000)

  it('counts calls against the daily budget', async () => {
    await throttled('a', async () => 1)
    await throttled('b', async () => 2)
    expect(getThrottleStats().calls).toBe(2)
  }, 10000)
})

describe('flood handling', () => {
  it('converts a flood error and records it', async () => {
    await expect(
      throttled('boom', async () => { throw new Error('A wait of 30 seconds is required (FLOOD_WAIT)') })
    ).rejects.toBeInstanceOf(FloodWaitError)

    const stats = getThrottleStats()
    expect(stats.floodWaits).toBe(1)
    expect(stats.floodUntil).not.toBeNull()
  }, 10000)

  it('pauses every caller, not just the one that tripped it', async () => {
    await expect(
      throttled('boom', async () => { throw new Error('A wait of 900 seconds is required (FLOOD_WAIT)') })
    ).rejects.toBeInstanceOf(FloodWaitError)

    // A penalty beyond the ceiling is refused outright rather than queued behind.
    await expect(throttled('next', async () => 'ok')).rejects.toBeInstanceOf(FloodWaitError)
  }, 10000)

  it('never retries a flooded call silently', async () => {
    let attempts = 0
    await expect(
      throttled('boom', async () => {
        attempts++
        throw new Error('A wait of 900 seconds is required (FLOOD_WAIT)')
      })
    ).rejects.toThrow()
    expect(attempts).toBe(1)
  }, 10000)

  it('passes ordinary errors through untouched', async () => {
    await expect(
      throttled('boom', async () => { throw new Error('CHAT_ID_INVALID') })
    ).rejects.toThrow('CHAT_ID_INVALID')
    expect(getThrottleStats().floodWaits).toBe(0)
  }, 10000)

  it('keeps working after a failure — the queue does not deadlock', async () => {
    await expect(throttled('boom', async () => { throw new Error('nope') })).rejects.toThrow()
    await expect(throttled('after', async () => 'ok')).resolves.toBe('ok')
  }, 10000)
})

describe('typingDelayMs', () => {
  it('scales with length', () => {
    expect(typingDelayMs('коротко')).toBeLessThan(typingDelayMs('а'.repeat(200)))
  })

  it('is never instant — an immediate reply is the clearest tell', () => {
    expect(typingDelayMs('ок')).toBeGreaterThanOrEqual(1500)
  })

  it('is capped so a long message does not stall the agent', () => {
    expect(typingDelayMs('а'.repeat(5000))).toBeLessThanOrEqual(12000)
  })
})

describe('daily counter across midnight', () => {
  it('reports zero when the recorded day is not today', async () => {
    // The counter resets lazily, on the next call. An idle daemon crossing
    // midnight would otherwise keep printing yesterday's number in its health
    // line — which is exactly the kind of stale figure that hides an outage.
    resetThrottle()
    await throttled('probe', async () => 'ok')
    expect(getThrottleStats().calls).toBe(1)

    const dayAfterTomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
    vi.useFakeTimers()
    vi.setSystemTime(dayAfterTomorrow)
    try {
      expect(getThrottleStats().calls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

/** In-memory stand-in for the database the daemon injects. */
function fakeStore(seed: Record<string, Record<string, number>> = {}) {
  const days: Record<string, Record<string, number>> = { ...seed }
  return {
    days,
    note(day: string, label: string) {
      days[day] = days[day] ?? {}
      days[day]![label] = (days[day]![label] ?? 0) + 1
    },
    load(day: string) {
      const byLabel = { ...(days[day] ?? {}) }
      return { total: Object.values(byLabel).reduce((a, b) => a + b, 0), byLabel }
    },
  }
}

const TODAY = new Date().toISOString().slice(0, 10)

describe('call accounting', () => {
  beforeEach(() => configureThrottle({ minIntervalMs: 0, jitterMs: 0 }))

  it('records which call site spent the budget', async () => {
    // A bare total says whether we are near the ceiling and nothing about what
    // to look at. On 6 Sep 2026 usage jumped 193 calls in fifteen minutes and
    // the cause was unrecoverable from the logs.
    await throttled('getDialogs', async () => 1)
    await throttled('getMessages', async () => 1)
    await throttled('getMessages', async () => 1)

    const stats = getThrottleStats()
    expect(stats.calls).toBe(3)
    expect(stats.byLabel).toEqual({ getDialogs: 1, getMessages: 2 })
    expect(topLabels(stats, 1)).toBe('getMessages 2')
  })

  it('counts a failed call — it reached Telegram either way', async () => {
    await expect(throttled('boom', async () => { throw new Error('nope') })).rejects.toThrow()
    expect(getThrottleStats().calls).toBe(1)
  })

  it('resumes the day\'s count instead of starting over', async () => {
    // The daemon restarted 24 times on 6 Sep 2026, and every start reported a
    // few dozen calls while the real day was several hundred. A budget a crash
    // loop can reset is not a budget.
    const store = fakeStore({ [TODAY]: { getDialogs: 40 } })
    configureThrottlePersistence(store)

    expect(getThrottleStats().calls).toBe(40)
    await throttled('getMessages', async () => 1)
    expect(getThrottleStats().calls).toBe(41)
    expect(store.days[TODAY]!['getMessages']).toBe(1)
  })

  it('starts clean on a day the store has never seen', async () => {
    const store = fakeStore()
    configureThrottlePersistence(store)
    expect(getThrottleStats().calls).toBe(0)
  })

  it('keeps counting in memory when nothing is attached', async () => {
    await throttled('x', async () => 1)
    expect(getThrottleStats().calls).toBe(1)
  })
})

describe('countUnpacedCall', () => {
  it('counts the watchdog probe, which used to be invisible', () => {
    // It skips the queue on purpose — a probe waiting out a FLOOD_WAIT pause
    // longer than its own timeout would read as a dead connection and restart
    // the daemon over an accounting number. But it is still a real request.
    countUnpacedCall('watchdog.getMe')
    countUnpacedCall('watchdog.getMe')

    const stats = getThrottleStats()
    expect(stats.calls).toBe(2)
    expect(stats.byLabel['watchdog.getMe']).toBe(2)
  })

  it('writes through to the store like any other call', () => {
    const store = fakeStore()
    configureThrottlePersistence(store)
    countUnpacedCall('watchdog.getMe')
    expect(store.days[TODAY]!['watchdog.getMe']).toBe(1)
  })
})

describe('topLabels', () => {
  it('says nothing when nothing has been called', () => {
    expect(topLabels(getThrottleStats())).toBe('')
  })

  it('keeps only the biggest spenders', () => {
    const stats = { calls: 6, floodWaits: 0, budgetDate: TODAY, floodUntil: null,
      byLabel: { a: 1, b: 5, c: 3, d: 2, e: 9 } }
    expect(topLabels(stats, 2)).toBe('e 9, b 5')
  })
})
