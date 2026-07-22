import { describe, it, expect, vi } from 'vitest'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { setActiveQuery, interruptRequest, addFollowup, subagentStarted, subagentFinished, hasSubagentsInFlight, clearActiveQuery } from './request-queue.js'

function makeQuery(interruptImpl: () => Promise<unknown>): Query {
  return { interrupt: vi.fn(interruptImpl) } as unknown as Query
}

describe('interruptRequest', () => {
  it('returns interrupted:false when there is no active query', async () => {
    const r = await interruptRequest('no-such-chat')
    expect(r).toEqual({ interrupted: false, stillQueued: 0 })
  })

  it('reports still_queued count from an interrupt_receipt_v1 receipt', async () => {
    const key = 'rq-1'
    setActiveQuery(key, makeQuery(async () => ({ still_queued: ['a', 'b', 'c'] })))
    const r = await interruptRequest(key)
    expect(r).toEqual({ interrupted: true, stillQueued: 3 })
  })

  it('handles an older CLI that resolves interrupt() to undefined', async () => {
    const key = 'rq-2'
    setActiveQuery(key, makeQuery(async () => undefined))
    const r = await interruptRequest(key)
    expect(r).toEqual({ interrupted: true, stillQueued: 0 })
  })

  it('treats an empty still_queued as nothing surviving', async () => {
    const key = 'rq-3'
    setActiveQuery(key, makeQuery(async () => ({ still_queued: [] })))
    const r = await interruptRequest(key)
    expect(r).toEqual({ interrupted: true, stillQueued: 0 })
  })

  it('swallows a rejected interrupt() and still reports interrupted', async () => {
    const key = 'rq-4'
    setActiveQuery(key, makeQuery(async () => { throw new Error('query already finished') }))
    const r = await interruptRequest(key)
    expect(r).toEqual({ interrupted: true, stillQueued: 0 })
  })

  it('guards against a malformed still_queued field (non-array)', async () => {
    const key = 'rq-5'
    setActiveQuery(key, makeQuery(async () => ({ still_queued: 'oops' })))
    const r = await interruptRequest(key)
    expect(r).toEqual({ interrupted: true, stillQueued: 0 })
  })
})

describe('subagent in-flight tracking', () => {
  it('tracks started/finished task ids per session', () => {
    const key = 'sub-1'
    expect(hasSubagentsInFlight(key)).toBe(false)
    subagentStarted(key, 't1')
    subagentStarted(key, 't2')
    expect(hasSubagentsInFlight(key)).toBe(true)
    subagentFinished(key, 't1')
    expect(hasSubagentsInFlight(key)).toBe(true)
    subagentFinished(key, 't2')
    expect(hasSubagentsInFlight(key)).toBe(false)
  })

  it('clearActiveQuery drops any leftover subagents', () => {
    const key = 'sub-2'
    subagentStarted(key, 't1')
    expect(hasSubagentsInFlight(key)).toBe(true)
    clearActiveQuery(key)
    expect(hasSubagentsInFlight(key)).toBe(false)
  })
})

describe('addFollowup interrupt gating', () => {
  it('skips interrupt while a subagent runs and protectSubagents is on', async () => {
    const key = 'fu-1'
    const q = makeQuery(async () => undefined)
    setActiveQuery(key, q)
    subagentStarted(key, 't1')
    await addFollowup(key, 'hi', true)
    expect(q.interrupt).not.toHaveBeenCalled()
    clearActiveQuery(key)
  })

  it('interrupts when no subagent is running even with protection on', async () => {
    const key = 'fu-2'
    const q = makeQuery(async () => undefined)
    setActiveQuery(key, q)
    await addFollowup(key, 'hi', true)
    expect(q.interrupt).toHaveBeenCalledOnce()
    clearActiveQuery(key)
  })

  it('interrupts despite a running subagent when protection is off', async () => {
    const key = 'fu-3'
    const q = makeQuery(async () => undefined)
    setActiveQuery(key, q)
    subagentStarted(key, 't1')
    await addFollowup(key, 'hi', false)
    expect(q.interrupt).toHaveBeenCalledOnce()
    clearActiveQuery(key)
  })
})
