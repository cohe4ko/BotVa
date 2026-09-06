import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  throttled, parseFloodWait, typingDelayMs, getThrottleStats, resetThrottle,
  FloodWaitError,
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
