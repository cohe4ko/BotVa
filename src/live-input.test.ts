import { describe, it, expect, vi } from 'vitest'
import { LiveInput } from './live-input.js'

async function take(input: LiveInput, n: number): Promise<string[]> {
  const out: string[] = []
  const it = input[Symbol.asyncIterator]()
  while (out.length < n) {
    const r = await it.next()
    if (r.done) break
    out.push(r.value.message.content as string)
  }
  return out
}

describe('LiveInput', () => {
  it('yields pushed messages in order as SDK user messages', async () => {
    const input = new LiveInput()
    input.push('a')
    input.push('b')
    const it = input[Symbol.asyncIterator]()
    const first = await it.next()
    expect(first.value).toMatchObject({ type: 'user', message: { role: 'user', content: 'a' }, parent_tool_use_id: null })
    expect((await it.next()).value.message.content).toBe('b')
  })

  it('waits for a message pushed later', async () => {
    const input = new LiveInput()
    const got = take(input, 1)
    setTimeout(() => input.push('late'), 5)
    expect(await got).toEqual(['late'])
  })

  it('hands over what is queued before ending once closed', async () => {
    const input = new LiveInput()
    input.push('queued')
    input.close()
    const it = input[Symbol.asyncIterator]()
    expect((await it.next()).value.message.content).toBe('queued')
    expect((await it.next()).done).toBe(true)
  })

  it('ends a waiting reader on close and refuses pushes after it', async () => {
    const input = new LiveInput()
    const it = input[Symbol.asyncIterator]()
    const pending = it.next()
    input.close()
    expect((await pending).done).toBe(true)
    expect(input.push('x')).toBe(false)
    expect(input.isClosed).toBe(true)
  })

  it('calls onPush for every accepted message', () => {
    const input = new LiveInput()
    input.onPush = vi.fn()
    input.push('a')
    input.close()
    input.push('b')
    expect(input.onPush).toHaveBeenCalledOnce()
  })
})
