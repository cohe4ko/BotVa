import { describe, it, expect } from 'vitest'
import { parseVariants, decisionWords } from './variants.js'

describe('parseVariants', () => {
  it('reads labelled variants and an advice line', () => {
    const r = parseVariants('ADVICE: be careful\n=== Так ===\nYes.\n=== Ні ===\nNo, sorry.\n')
    expect(r.advice).toBe('be careful')
    expect(r.variants).toEqual([{ label: 'Так', text: 'Yes.' }, { label: 'Ні', text: 'No, sorry.' }])
  })

  it('reads decisions and trailing JSON data', () => {
    const r = parseVariants('=== counter | Четвер ===\nThursday?\nDATA: {"day": "thu"}\n=== reject | Ні ===\nNo.')
    expect(r.variants[0]).toEqual({ label: 'Четвер', text: 'Thursday?', decision: 'counter', data: { day: 'thu' } })
    expect(r.variants[1].decision).toBe('rejected')
  })

  it('treats text without headers as one reply, and keeps the old NO-ANSWER contract', () => {
    expect(parseVariants('Just this.').variants).toEqual([{ label: 'Відповідь', text: 'Just this.' }])
    expect(parseVariants('NO-ANSWER: spam')).toEqual({ variants: [], advice: 'spam' })
    expect(parseVariants('').variants).toEqual([])
  })

  it('keeps at most three and drops empty ones; bad JSON stays in the text', () => {
    const r = parseVariants('=== a ===\n1\n=== b ===\n\n=== c ===\n3\n=== d ===\n4\n=== e ===\n5')
    expect(r.variants.map(v => v.label)).toEqual(['a', 'c', 'd'])
    expect(parseVariants('=== x ===\nhi\nDATA: {broken').variants[0].text).toContain('DATA: {broken')
  })

  it('words for decisions', () => {
    expect(decisionWords('counter')).toBe('зустрічна пропозиція')
    expect(decisionWords(null)).toBe('')
  })
})
