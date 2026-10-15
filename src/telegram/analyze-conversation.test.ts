import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', () => ({ ALLOWED_CHAT_ID: '0' }))
vi.mock('../model.js', () => ({
  getBackgroundModel: () => 'haiku',
  parseModelConfig: () => ({ model: 'claude-haiku-4-5-20251001' }),
}))

import { parseAnalysis, normalizeItem, buildPrompt, dedupeItems } from './analyze-conversation.js'

const CHUNK_IDS = [10, 11, 12]

const item = (over: Record<string, unknown> = {}) => ({
  text: 'Марта привезе документи в четвер',
  who: 'Марта',
  confidence: 0.82,
  when_due: '2026-09-10T15:00',
  topic: 'work',
  tags: 'документи,documents',
  quote: 'привезу в четвер',
  msg_ids: [11],
  ...over,
})

describe('parseAnalysis', () => {
  it('reads every category into a flat list of items', () => {
    const raw = JSON.stringify({
      facts: [item()],
      commitments_theirs: [item({ text: 'інше', quote: 'цитата' })],
      requests: [],
    })
    const items = parseAnalysis(raw, CHUNK_IDS)
    expect(items).toHaveLength(2)
    expect(items.map(i => i.kind)).toEqual(['facts', 'commitments_theirs'])
  })

  it('survives the markdown fence a model adds unasked', () => {
    const raw = '```json\n' + JSON.stringify({ facts: [item()] }) + '\n```'
    expect(parseAnalysis(raw, CHUNK_IDS)).toHaveLength(1)
  })

  it('returns nothing rather than throwing on unparseable output', () => {
    expect(parseAnalysis('вибач, не можу', CHUNK_IDS)).toEqual([])
  })

  it('loses one malformed item, not the whole conversation', () => {
    const raw = JSON.stringify({ facts: [item(), { text: 'без цитати' }, item({ text: 'третій' })] })
    expect(parseAnalysis(raw, CHUNK_IDS)).toHaveLength(2)
  })

  it('ignores a category that came back as something other than a list', () => {
    const raw = JSON.stringify({ facts: item(), events: [item()] })
    const items = parseAnalysis(raw, CHUNK_IDS)
    expect(items.map(i => i.kind)).toEqual(['events'])
  })
})

describe('normalizeItem', () => {
  it('refuses an item with no quote', () => {
    // The quote is the audit trail. Without it the item can be neither checked
    // nor invalidated when its source changes.
    expect(normalizeItem('facts', item({ quote: '' }), CHUNK_IDS)).toBeNull()
    expect(normalizeItem('facts', item({ text: '' }), CHUNK_IDS)).toBeNull()
  })

  it('falls back to the chunk when the model cites no message ids', () => {
    expect(normalizeItem('facts', item({ msg_ids: [] }), CHUNK_IDS)!.msg_ids).toEqual(CHUNK_IDS)
    expect(normalizeItem('facts', item({ msg_ids: 'дві' }), CHUNK_IDS)!.msg_ids).toEqual(CHUNK_IDS)
  })

  it('clamps a confidence that came back out of range', () => {
    expect(normalizeItem('facts', item({ confidence: 5 }), CHUNK_IDS)!.confidence).toBe(1)
    expect(normalizeItem('facts', item({ confidence: -1 }), CHUNK_IDS)!.confidence).toBe(0)
    expect(normalizeItem('facts', item({ confidence: 'дуже' }), CHUNK_IDS)!.confidence).toBe(0)
  })

  it('keeps only a date it can actually schedule on', () => {
    // "наступної п'ятниці" is not a date, and turning it into one by guessing
    // is how a reminder fires on the wrong day.
    expect(normalizeItem('facts', item({ when_due: "наступної п'ятниці" }), CHUNK_IDS)!.when_due).toBeNull()
    expect(normalizeItem('facts', item({ when_due: 'null' }), CHUNK_IDS)!.when_due).toBeNull()
    expect(normalizeItem('facts', item({ when_due: '2026-09-10' }), CHUNK_IDS)!.when_due).toBe('2026-09-10')
  })

  it('normalises a topic the model wrote as a phrase', () => {
    expect(normalizeItem('facts', item({ topic: '' }), CHUNK_IDS)!.topic).toBe('general')
  })
})

describe('buildPrompt', () => {
  const chunk = {
    chatTitle: 'Марта',
    chatKind: 'user',
    participants: ['Марта Коваль @marta — підрядниця'],
    transcript: '[06.09 12:00 #11] Марта: привезу в четвер',
    msgIds: [11],
    allowTasks: true,
  }

  it('names the participants so the model never writes "he said"', () => {
    const p = buildPrompt(chunk)
    expect(p).toContain('Марта Коваль @marta — підрядниця')
  })

  it('spells out that incoming and outgoing mean opposite things', () => {
    const p = buildPrompt(chunk)
    expect(p).toContain('commitments_mine')
    expect(p).toContain('requests')
    expect(p).toContain('ВХІДНІ Й ВИХІДНІ — РІЗНІ РЕЧІ')
  })

  it('carries the transcript with its message ids', () => {
    expect(buildPrompt(chunk)).toContain('#11')
  })

  it('says the participant list is unknown rather than leaving a hole', () => {
    expect(buildPrompt({ ...chunk, participants: [] })).toContain('(невідомі)')
  })
})

describe('dedupeItems', () => {
  const mk = (over: Record<string, unknown>) => ({
    kind: 'dates', text: 't', who: '', confidence: 0.8, when_due: '2026-09-11',
    topic: 'work', tags: '', quote: 'q', msg_ids: [504], ...over,
  }) as never

  it('drops a date that only restates a commitment from the same message', () => {
    // Observed on a live run: the same advance payment came back as both a
    // promise and a date, which would mean two facts and two reminders.
    const items = [mk({ kind: 'commitments_mine' }), mk({})]
    const out = dedupeItems(items)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('commitments_mine')
  })

  it('keeps a date that stands on its own', () => {
    const items = [mk({ kind: 'commitments_mine', msg_ids: [504] }), mk({ msg_ids: [777] })]
    expect(dedupeItems(items)).toHaveLength(2)
  })

  it('keeps a date from the same message when the deadline differs', () => {
    const items = [mk({ kind: 'commitments_mine' }), mk({ when_due: '2026-09-14' })]
    expect(dedupeItems(items)).toHaveLength(2)
  })

  it('never drops anything that is not a date item', () => {
    const items = [mk({ kind: 'commitments_mine' }), mk({ kind: 'facts' }), mk({ kind: 'events' })]
    expect(dedupeItems(items)).toHaveLength(3)
  })
})
