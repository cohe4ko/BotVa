import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('deduplication', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('new message is not a duplicate', async () => {
    const { isDuplicate, stopDeduplication } = await import('./deduplication.js')
    expect(isDuplicate(999)).toBe(false)
    stopDeduplication()
  })

  it('marks message as duplicate after markProcessed', async () => {
    const { isDuplicate, markProcessed, stopDeduplication } = await import('./deduplication.js')
    markProcessed(123)
    expect(isDuplicate(123)).toBe(true)
    stopDeduplication()
  })

  it('cleanup removes expired entries after TTL', async () => {
    const { isDuplicate, markProcessed, stopDeduplication } = await import('./deduplication.js')
    markProcessed(100)
    expect(isDuplicate(100)).toBe(true)

    // Advance past TTL (60s) + cleanup interval (30s)
    vi.advanceTimersByTime(91000)

    expect(isDuplicate(100)).toBe(false)
    stopDeduplication()
  })

  it('stopDeduplication clears interval', async () => {
    const { markProcessed, stopDeduplication } = await import('./deduplication.js')
    markProcessed(200)
    stopDeduplication()
    // No error when calling stop again
    stopDeduplication()
  })
})
