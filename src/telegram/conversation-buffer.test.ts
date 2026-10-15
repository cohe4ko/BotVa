import { describe, it, expect } from 'vitest'

import {
  shouldFlush, secondsUntilDue, IDLE_FLUSH_S, MAX_BUFFERED, MAX_AGE_S, MIN_FLUSH_GAP_S,
} from './conversation-buffer.js'

const NOW = 1_700_000_000

/** A chat that just received a message and has never been analysed. */
const fresh = (over: Partial<Parameters<typeof shouldFlush>[0]> = {}) => ({
  pending: 3,
  oldestTs: NOW - 30,
  newestTs: NOW - 5,
  lastFlushTs: 0,
  ...over,
})

describe('shouldFlush', () => {
  it('waits while the conversation is still going', () => {
    expect(shouldFlush(fresh(), NOW).flush).toBe(false)
  })

  it('does nothing when there is nothing to analyse', () => {
    expect(shouldFlush(fresh({ pending: 0 }), NOW).flush).toBe(false)
  })

  it('flushes after the conversation goes quiet', () => {
    const d = shouldFlush(fresh({ newestTs: NOW - IDLE_FLUSH_S }), NOW)
    expect(d).toEqual({ flush: true, reason: 'idle' })
  })

  it('flushes a burst before it grows past the chunk size', () => {
    const d = shouldFlush(fresh({ pending: MAX_BUFFERED }), NOW)
    expect(d).toEqual({ flush: true, reason: 'full' })
  })

  it('flushes a conversation that never stops, on age alone', () => {
    // Still lively — the newest message is seconds old — but the oldest has
    // been waiting half an hour, and nothing should sit unanalysed that long.
    const d = shouldFlush(fresh({ oldestTs: NOW - MAX_AGE_S, newestTs: NOW - 1 }), NOW)
    expect(d).toEqual({ flush: true, reason: 'aged' })
  })

  it('holds off when the chat was analysed a moment ago', () => {
    // Someone typing continuously would otherwise be re-analysed every few
    // seconds on nearly the same text.
    const d = shouldFlush(fresh({ pending: MAX_BUFFERED, lastFlushTs: NOW - 10 }), NOW)
    expect(d.flush).toBe(false)
  })

  it('resumes once the gap has passed', () => {
    const d = shouldFlush(fresh({ pending: MAX_BUFFERED, lastFlushTs: NOW - MIN_FLUSH_GAP_S }), NOW)
    expect(d).toEqual({ flush: true, reason: 'full' })
  })
})

describe('secondsUntilDue', () => {
  it('is null when the chat has nothing pending', () => {
    expect(secondsUntilDue(fresh({ pending: 0 }), NOW)).toBeNull()
  })

  it('counts down to the idle deadline', () => {
    expect(secondsUntilDue(fresh({ newestTs: NOW - 60 }), NOW)).toBe(IDLE_FLUSH_S - 60)
  })

  it('is zero for a full buffer that is past its gap', () => {
    expect(secondsUntilDue(fresh({ pending: MAX_BUFFERED }), NOW)).toBe(0)
  })

  it('never returns a moment when the gap would still block the flush', () => {
    const s = fresh({ pending: MAX_BUFFERED, lastFlushTs: NOW - 10 })
    expect(secondsUntilDue(s, NOW)).toBe(MIN_FLUSH_GAP_S - 10)
  })

  it('takes the nearer of the idle and age deadlines', () => {
    // Long-running conversation: age expires before the idle timer would.
    const s = fresh({ oldestTs: NOW - MAX_AGE_S + 30, newestTs: NOW })
    expect(secondsUntilDue(s, NOW)).toBe(30)
  })
})
