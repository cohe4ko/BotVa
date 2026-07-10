import { describe, it, expect, vi } from 'vitest'

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { ProgressReporter } from './progress-reporter.js'

// Minimal Api stub — the reporter only needs it for flush (which we never trigger here).
const apiStub = {} as any

// Access private members for white-box assertions on the formatted lines.
function makeReporter(cuteMode = false) {
  const r = new ProgressReporter(123, apiStub, undefined, cuteMode, 'uk') as any
  return r
}

// Recording Api mock for flush/rollover tests.
function makeApi() {
  let nextId = 1000
  return {
    sendMessage: vi.fn(async (_chatId: number, text: string, opts: any) => {
      void text; void opts
      return { message_id: nextId++ }
    }),
    editMessageText: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
  }
}

// Full-log reporter wired to a recording Api.
function makeFullReporter(api: any, cuteMode = false) {
  const r = new ProgressReporter(123, api, Infinity, cuteMode, 'uk', false, true) as any
  return r
}

describe('ProgressReporter — api_retry', () => {
  it('renders an overloaded retry line with N/M counter', () => {
    const r = makeReporter()
    const changed = r.formatEvent({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5, error: 'overloaded' })
    expect(changed).toBe(true)
    expect(r.lines.at(-1)).toContain('повтор 1/5')
    expect(r.lines.at(-1)).toContain('перевантажений')
  })

  it('distinguishes rate_limit from overloaded', () => {
    const r = makeReporter()
    r.formatEvent({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, error: 'rate_limit' })
    expect(r.lines.at(-1)).toContain('Ліміт запитів')
    expect(r.lines.at(-1)).toContain('повтор 2/5')
  })

  it('updates one line in place instead of appending per retry', () => {
    const r = makeReporter()
    r.formatEvent({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, error: 'overloaded' })
    const lenAfterFirst = r.lines.length
    r.formatEvent({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 3, error: 'overloaded' })
    r.formatEvent({ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 3, error: 'overloaded' })
    expect(r.lines.length).toBe(lenAfterFirst)
    expect(r.lines.at(-1)).toContain('повтор 3/3')
  })

  it('starts a fresh retry line after a new turn (followup marker)', () => {
    const r = makeReporter()
    r.formatEvent({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, error: 'overloaded' })
    r.addFollowupMarker('next question')
    r.formatEvent({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, error: 'overloaded' })
    // Two distinct retry lines now exist (one per turn)
    const retryLines = r.lines.filter((l: string) => l.includes('повтор'))
    expect(retryLines.length).toBe(2)
  })

  it('uses cute wording in cute mode', () => {
    const r = makeReporter(true)
    r.formatEvent({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5, error: 'overloaded' })
    expect(r.lines.at(-1)).toContain('трішки зачекаємо')
  })
})

describe('ProgressReporter — model fallback', () => {
  it('renders a fallback line naming the fallback model', () => {
    const r = makeReporter()
    const changed = r.formatEvent({
      type: 'system',
      subtype: 'model_refusal_fallback',
      direction: 'retry',
      original_model: 'opus',
      fallback_model: 'sonnet',
    })
    expect(changed).toBe(true)
    expect(r.lines.at(-1)).toContain('🔀')
    expect(r.lines.at(-1)).toContain('sonnet')
  })

  it('uses cute wording in cute mode', () => {
    const r = makeReporter(true)
    r.formatEvent({
      type: 'system',
      subtype: 'model_refusal_fallback',
      direction: 'retry',
      original_model: 'opus',
      fallback_model: 'sonnet',
    })
    expect(r.lines.at(-1)).toContain('запасний мозок')
  })
})

describe('ProgressReporter — full-log line retention', () => {
  it('does NOT evict lines when full-log is enabled', () => {
    const r = makeFullReporter(makeApi())
    for (let i = 0; i < 50; i++) r.addLine(`<code>l${i}</code>`)
    // Full-log mode keeps everything (rollover, not eviction, bounds the message)
    expect(r.lines.length).toBe(50)
    expect(r.lines[0]).toContain('l0')
  })

  it('flag-off preserves the legacy 20-line eviction window (byte-for-byte)', () => {
    const r = makeReporter() // fullLog defaults to false
    for (let i = 0; i < 30; i++) r.addLine(`<code>l${i}</code>`)
    expect(r.lines.length).toBe(20)
    // Oldest lines evicted, newest kept
    expect(r.lines[0]).toContain('l10')
    expect(r.lines.at(-1)).toContain('l29')
  })

  it('shouldRollover never fires when the flag is off', () => {
    const r = makeReporter()
    r.messageId = 500
    for (let i = 0; i < 100; i++) r.lines.push(`<code>${'x'.repeat(80)}</code>`)
    expect(r.shouldRollover()).toBe(false)
  })
})

describe('ProgressReporter — chained rollover', () => {
  it('rolls over at the line-count threshold: freezes old, sends new link', async () => {
    const api = makeApi()
    const r = makeFullReporter(api)
    r.messageId = 500 // an existing live message
    for (let i = 0; i < 45; i++) r.lines.push(`<code>line ${i}</code>`)
    r.dirty = true

    await r.flush()

    // New link sent (with buttons), old message frozen (final edit, no buttons)
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(api.sendMessage.mock.calls[0][2].reply_markup).toBeDefined()

    const editCall = api.editMessageText.mock.calls.find((c: any[]) => c[1] === 500)
    expect(editCall).toBeDefined()
    expect(editCall[3].reply_markup).toBeUndefined() // buttons removed from frozen msg
    // Frozen snapshot keeps everything before rollover
    expect(editCall[2]).toContain('line 0')
    expect(editCall[2]).toContain('line 44')

    // Old id archived; live message is now the new link
    expect(r.chainIds).toEqual([500])
    expect(r.messageId).toBe(1000)
    // Nothing active to migrate → new link starts empty
    expect(r.lines.length).toBe(0)
  })

  it('rolls over at the char threshold too', async () => {
    const api = makeApi()
    const r = makeFullReporter(api)
    r.messageId = 500
    // A handful of very long lines exceed ROLLOVER_CHARS (3500) without hitting 40 lines
    for (let i = 0; i < 5; i++) r.lines.push(`<code>${'y'.repeat(900)}</code>`)
    r.dirty = true

    await r.flush()

    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(r.chainIds).toEqual([500])
  })

  it('migrates the thinking tail into the new link (index fixups)', async () => {
    const api = makeApi()
    const r = makeFullReporter(api)
    r.messageId = 500
    // Active thinking of >2000 chars so the preview is a tail
    r.thinkingText = 'z'.repeat(2500)
    r.thinkingLineIdx = 0
    r.lines = [r.thinkingLineString(r.thinkingText)]
    for (let i = 0; i < 45; i++) r.lines.push(`<code>l${i}</code>`)
    r.dirty = true

    await r.flush()

    // New link carries only the migrated thinking line, reindexed to 0
    expect(r.lines.length).toBe(1)
    expect(r.thinkingLineIdx).toBe(0)
    expect(r.lines[0]).toContain('🧠')
    expect(r.lines[0]).toContain('...') // recent tail, not the head
    // New message body sent to Telegram carries the thinking continuation
    expect(api.sendMessage.mock.calls[0][1]).toContain('🧠')
  })

  it('migrates active streaming and clears stale tool indices', async () => {
    const api = makeApi()
    const r = makeFullReporter(api)
    r.messageId = 500
    r.thinkingText = 'z'.repeat(40)
    r.thinkingLineIdx = 0
    r.streamingText = 'w'.repeat(700)
    r.streamingLineIdx = 1
    r.lines = [r.thinkingLineString(r.thinkingText), r.streamLineString()]
    r.toolLines.set('tool-1', 0)
    r.toolNames.set('tool-1', 'Read')
    for (let i = 0; i < 45; i++) r.lines.push(`<code>l${i}</code>`)
    r.dirty = true

    await r.flush()

    // Both active lines migrated, indices fixed up
    expect(r.lines.length).toBe(2)
    expect(r.thinkingLineIdx).toBe(0)
    expect(r.streamingLineIdx).toBe(1)
    expect(r.lines[1]).toContain('✍️')
    // Stale tool references (they belong to the frozen snapshot) are dropped
    expect(r.toolLines.size).toBe(0)
    expect(r.toolNames.size).toBe(0)
  })

  it('keeps editing the old message if the new link send fails', async () => {
    const api = makeApi()
    api.sendMessage = vi.fn(async () => { throw new Error('flood wait') })
    const r = makeFullReporter(api)
    r.messageId = 500
    for (let i = 0; i < 45; i++) r.lines.push(`<code>line ${i}</code>`)
    r.dirty = true

    await r.flush()

    // Rollover aborted — old message stays live, nothing archived
    expect(r.chainIds).toEqual([])
    expect(r.messageId).toBe(500)
    // Fell through to a normal in-place edit of the old message
    const editCall = api.editMessageText.mock.calls.find((c: any[]) => c[1] === 500)
    expect(editCall).toBeDefined()
    expect(editCall[3].reply_markup).toBeDefined() // buttons still present
  })

  it('does not roll over on the very first flush (no live message yet)', async () => {
    const api = makeApi()
    const r = makeFullReporter(api)
    for (let i = 0; i < 45; i++) r.lines.push(`<code>line ${i}</code>`)
    r.dirty = true

    await r.flush()

    // First flush just sends the initial message; no freeze/archive happens
    expect(r.chainIds).toEqual([])
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(r.messageId).toBe(1000)
    expect(r.lines.length).toBe(45) // untouched
  })
})
