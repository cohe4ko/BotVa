import { describe, it, expect } from 'vitest'
import { resultPayload, structuredOf, jsonOutput, CONVERSATION_ANALYSIS_SCHEMA, LISTENER_ANALYSIS_SCHEMA } from './structured-output.js'
import { ITEM_KINDS } from './telegram/analyze-conversation.js'

const ok = (extra: Record<string, unknown>) => ({ type: 'result', subtype: 'success', result: 'text answer', ...extra }) as any

describe('structured output helpers', () => {
  it('prefers the structured payload over the text', () => {
    const ev = ok({ structured_output: { a: 1 } })
    expect(structuredOf(ev)).toEqual({ a: 1 })
    expect(resultPayload(ev)).toBe('{"a":1}')
  })

  it('falls back to the result text, and to errors on failure', () => {
    expect(resultPayload(ok({}))).toBe('text answer')
    expect(resultPayload({ type: 'result', subtype: 'error_during_execution', errors: ['boom'] } as any)).toBe('boom')
    expect(structuredOf({ type: 'assistant' } as any)).toBeUndefined()
  })

  it('wraps a schema as an SDK output format', () => {
    expect(jsonOutput({ type: 'object' })).toEqual({ type: 'json_schema', schema: { type: 'object' } })
  })

  it('covers every conversation item kind', () => {
    expect(Object.keys((CONVERSATION_ANALYSIS_SCHEMA as any).properties).sort()).toEqual([...ITEM_KINDS].sort())
  })

  it('requires every listener field the parser reads', () => {
    expect((LISTENER_ANALYSIS_SCHEMA as any).required).toEqual(expect.arrayContaining(['facts', 'summary', 'transcriptQuality']))
  })
})
