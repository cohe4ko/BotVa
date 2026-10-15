import { describe, it, expect, vi } from 'vitest'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { setActiveQuery, interruptRequest, addFollowup, getAndClearFollowup, setLiveRun, setBackgroundTasks, getBackgroundTasks, backgroundRequest, stopBackgroundTask, clearActiveQuery, backgroundKey, createAbortController, isCancelled, cancelRequest } from './request-queue.js'

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

describe('addFollowup', () => {
  it('pushes into the live run and never interrupts it', async () => {
    const key = 'fu-1'
    const q = makeQuery(async () => undefined)
    const pushed: string[] = []
    setActiveQuery(key, q)
    setLiveRun(key, { push: (t) => { pushed.push(t); return true } })
    await addFollowup(key, 'hi')
    expect(pushed).toEqual(['hi'])
    expect(q.interrupt).not.toHaveBeenCalled()
    expect(getAndClearFollowup(key)).toBeUndefined()
    clearActiveQuery(key)
  })

  it('keeps the message for the next run when the live input is closed', async () => {
    const key = 'fu-2'
    setLiveRun(key, { push: () => false })
    await addFollowup(key, 'one')
    await addFollowup(key, 'two')
    expect(getAndClearFollowup(key)).toBe('one\n\ntwo')
    clearActiveQuery(key)
  })

  it('keeps the message when no run is live yet', async () => {
    await addFollowup('fu-3', 'early')
    expect(getAndClearFollowup('fu-3')).toBe('early')
  })

  it('clearActiveQuery drops the live run and its background tasks', async () => {
    const key = 'fu-4'
    setLiveRun(key, { push: () => true })
    setBackgroundTasks(key, [{ taskId: 'b1', type: 'local_bash', description: 'x' }])
    clearActiveQuery(key)
    expect(getBackgroundTasks(key)).toEqual([])
    await addFollowup(key, 'after')
    expect(getAndClearFollowup(key)).toBe('after')
  })
})

describe('background controls', () => {
  it('backgroundRequest calls Query.backgroundTasks with the tool id', async () => {
    const key = 'bg-1'
    const q = { backgroundTasks: vi.fn(async () => true) } as unknown as Query
    setActiveQuery(key, q)
    expect(await backgroundRequest(key, 'tool-7')).toBe(true)
    expect(q.backgroundTasks).toHaveBeenCalledWith('tool-7')
    clearActiveQuery(key)
  })

  it('backgroundRequest is false with no run or when the SDK refuses', async () => {
    expect(await backgroundRequest('bg-none')).toBe(false)
    const key = 'bg-2'
    setActiveQuery(key, { backgroundTasks: vi.fn(async () => { throw new Error('disabled') }) } as unknown as Query)
    expect(await backgroundRequest(key)).toBe(false)
    clearActiveQuery(key)
  })

  it('stopBackgroundTask stops one task', async () => {
    const key = 'bg-3'
    const q = { stopTask: vi.fn(async () => undefined) } as unknown as Query
    setActiveQuery(key, q)
    expect(await stopBackgroundTask(key, 'b1')).toBe(true)
    expect(q.stopTask).toHaveBeenCalledWith('b1')
    clearActiveQuery(key)
  })

  it('an empty task list clears the entry', () => {
    setBackgroundTasks('bg-4', [{ taskId: 'b1', type: 't', description: 'd' }])
    expect(getBackgroundTasks('bg-4')).toHaveLength(1)
    setBackgroundTasks('bg-4', [])
    expect(getBackgroundTasks('bg-4')).toEqual([])
  })
})
