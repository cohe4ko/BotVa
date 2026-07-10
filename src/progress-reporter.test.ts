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
