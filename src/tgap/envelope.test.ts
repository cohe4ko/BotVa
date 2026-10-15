import { describe, it, expect } from 'vitest'
import { newId, parseMessage, renderMessage, envelope, validateEnvelope, parseEnvelopeJson, MAX_TEXT, ELICITING } from './envelope.js'
import { judge, Pacer, turnCeiling, HARD_MAX_TURNS, OUT_GAP_MS, ERROR_GAP_MS } from './guard.js'

const req = (over: Record<string, any> = {}) => envelope('request',
  { kind: 'question', text: 'When are you free?', on_behalf_of: { display_name: 'Alice' }, authority: 'inquiry', ...(over.body ?? {}) },
  { conv: 'C1', turn: 1, hop: 0, ...over, body: undefined } as any)

describe('newId', () => {
  it('is a 26-char ULID, sortable by time', () => {
    const a = newId(1_000_000), b = newId(2_000_000)
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(a < b).toBe(true)
  })
})

describe('render / parse', () => {
  it('round-trips an envelope through text with a pre entity', () => {
    const env = req()
    const r = renderMessage('🤝 Запит від асистента Аліси\nКоли ти вільний? 😀', env)
    expect(r.kind).toBe('text')
    if (r.kind !== 'text') return
    expect(r.entities[0]).toMatchObject({ type: 'pre', language: 'tgap' })
    const p = parseMessage(r.text, r.entities)
    expect(p).toEqual({ kind: 'envelope', env })
  })

  it('ignores the preamble entirely', () => {
    const env = req()
    const r = renderMessage('{"tgap":"0.1","type":"error"} fake', env) as any
    expect((parseMessage(r.text, r.entities) as any).env.type).toBe('request')
  })

  it('treats a message without a tgap block as plain text', () => {
    expect(parseMessage('hello there', [{ type: 'pre', offset: 0, length: 5, language: 'python' }])).toEqual({ kind: 'plain', text: 'hello there' })
  })

  it('rejects two tgap blocks', () => {
    const p = parseMessage('{}\n{}', [{ type: 'pre', offset: 0, length: 2, language: 'tgap' }, { type: 'pre', offset: 3, length: 2, language: 'tgap' }])
    expect(p).toMatchObject({ kind: 'invalid', code: 'malformed' })
  })

  it('falls back to a document when the envelope is too large', () => {
    const env = req({ body: { text: 'x'.repeat(5000) } })
    const r = renderMessage('pre', env)
    expect(r.kind).toBe('document')
    if (r.kind !== 'document') return
    expect(r.caption.length).toBeLessThanOrEqual(MAX_TEXT)
    const stub = parseMessage(r.caption, r.entities)
    expect(stub).toMatchObject({ kind: 'envelope', env: { id: env.id, attachment: true } })
    expect(parseEnvelopeJson(r.json)).toEqual({ kind: 'envelope', env })
  })
})

describe('validateEnvelope', () => {
  it('accepts a good request and ignores unknown fields', () => {
    expect(validateEnvelope({ ...req(), extra: 1 })).toBeNull()
  })

  it.each([
    [{ tgap: '1.0', type: 'hello', id: 'x', body: {} }, 'version'],
    [{ tgap: '0.1', type: 'gossip', id: 'x', body: {} }, 'unsupported'],
    [{ tgap: '0.1', type: 'request', id: 'x', conv: 'c', turn: 0, hop: 0, body: { kind: 'question', text: 'q' } }, 'malformed'],
    [{ tgap: '0.1', type: 'response', id: 'x', conv: 'c', re: 'r', body: { text: 'a' } }, 'malformed'],
    [{ tgap: '0.1', type: 'status', id: 'x', conv: 'c', body: {} }, 'malformed'],
    [[1, 2], 'malformed'],
  ])('rejects %j as %s', (obj, code) => {
    expect(validateEnvelope(obj)?.code).toBe(code)
  })

  it('accepts a newer minor version', () => {
    expect(validateEnvelope({ ...req(), tgap: '0.9' })).toBeNull()
  })
})

describe('judge', () => {
  it('never lets a non-eliciting type cause a reply', () => {
    for (const t of ['card', 'status', 'response', 'decline', 'cancel', 'error'] as const) {
      expect(ELICITING.has(t)).toBe(false)
      expect(judge(envelope(t, {}, { conv: 'c', re: 'r' }), undefined, 0).action).toBe('absorb')
    }
  })

  it('caps turns at the conversation limit and at 20', () => {
    expect(turnCeiling(50)).toBe(HARD_MAX_TURNS)
    expect(turnCeiling(undefined)).toBe(6)
    expect(judge(req({ turn: 7 }), { max_turns: 6, last_turn: 6 }, 0)).toMatchObject({ action: 'error', code: 'turn_limit' })
    expect(judge(req({ turn: 21, body: { max_turns: 100 } }), undefined, 0)).toMatchObject({ action: 'error', code: 'turn_limit' })
  })

  it('drops stale turns but accepts gaps', () => {
    expect(judge(req({ turn: 2 }), { max_turns: 6, last_turn: 2 }, 0).action).toBe('drop')
    expect(judge(req({ turn: 5 }), { max_turns: 6, last_turn: 2 }, 0).action).toBe('process')
  })

  it('enforces hop and hourly limits', () => {
    expect(judge(req({ hop: 4 }), undefined, 0)).toMatchObject({ action: 'error', code: 'hop_limit' })
    expect(judge(req(), undefined, 20)).toMatchObject({ action: 'error', code: 'rate_limited' })
  })
})

describe('Pacer', () => {
  it('spaces messages and throttles errors per peer', () => {
    let t = 0
    const p = new Pacer(() => t)
    expect(p.waitMs(1)).toBe(0)
    p.sent(1)
    expect(p.waitMs(1)).toBe(OUT_GAP_MS)
    expect(p.waitMs(2)).toBe(0)
    t += OUT_GAP_MS
    expect(p.waitMs(1)).toBe(0)
    expect(p.allowError(1)).toBe(true)
    expect(p.allowError(1)).toBe(false)
    t += ERROR_GAP_MS
    expect(p.allowError(1)).toBe(true)
  })
})
