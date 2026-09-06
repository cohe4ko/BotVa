import { describe, it, expect } from 'vitest'

import { watchdogAction, nextFailureCount } from './watchdog.js'

const EXITS_AFTER = 2

describe('watchdogAction', () => {
  it('does nothing while updates keep arriving', () => {
    expect(watchdogAction({ moved: true, alive: true, failedProbes: 0, exitsAfter: EXITS_AFTER }))
      .toBe('healthy')
  })

  it('accepts silence when the connection still answers', () => {
    // A quiet account is not a broken one — this is why the stalled counter
    // alone never triggers anything.
    expect(watchdogAction({ moved: false, alive: true, failedProbes: 0, exitsAfter: EXITS_AFTER }))
      .toBe('quiet')
  })

  it('reconnects on the first unanswered probe', () => {
    expect(watchdogAction({ moved: false, alive: false, failedProbes: 1, exitsAfter: EXITS_AFTER }))
      .toBe('reconnect')
  })

  it('gives up once the failures reach the limit', () => {
    expect(watchdogAction({ moved: false, alive: false, failedProbes: 2, exitsAfter: EXITS_AFTER }))
      .toBe('restart')
  })

  it('never restarts on a single failure, whatever the limit', () => {
    expect(watchdogAction({ moved: false, alive: false, failedProbes: 1, exitsAfter: 4 }))
      .toBe('reconnect')
  })

  it('treats moving updates as healthy even if a stale probe says otherwise', () => {
    // Updates arriving is direct evidence; the probe is only a fallback for
    // when that evidence is missing.
    expect(watchdogAction({ moved: true, alive: false, failedProbes: 5, exitsAfter: EXITS_AFTER }))
      .toBe('healthy')
  })
})

describe('nextFailureCount', () => {
  it('clears the streak once traffic or the connection comes back', () => {
    expect(nextFailureCount(3, 'healthy')).toBe(0)
    expect(nextFailureCount(3, 'quiet')).toBe(0)
  })

  it('keeps the streak while the connection stays silent', () => {
    expect(nextFailureCount(1, 'reconnect')).toBe(1)
    expect(nextFailureCount(2, 'restart')).toBe(2)
  })
})
