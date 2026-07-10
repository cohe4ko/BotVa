import { describe, it, expect, vi } from 'vitest'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { setActiveQuery, interruptRequest } from './request-queue.js'

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
