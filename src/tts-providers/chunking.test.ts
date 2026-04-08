import { describe, it, expect } from 'vitest'
import { splitIntoSentences, chunkText, capChunks, MAX_CHUNKS, isLongText, LONG_TEXT_THRESHOLD } from './chunking.js'

describe('splitIntoSentences', () => {
  it('splits on period, question, exclamation', () => {
    expect(splitIntoSentences('Привіт. Як справи? Добре!')).toEqual([
      'Привіт.', 'Як справи?', 'Добре!',
    ])
  })
  it('handles ellipsis and multiple punctuation', () => {
    expect(splitIntoSentences('Що це?! Хм…')).toEqual(['Що це?!', 'Хм…'])
  })
  it('does not split on abbreviations', () => {
    const out = splitIntoSentences('Це п. 2 договору. Наступне речення.')
    expect(out.length).toBe(2)
    expect(out[0]).toContain('п. 2 договору')
  })
  it('returns empty for empty/whitespace', () => {
    expect(splitIntoSentences('')).toEqual([])
    expect(splitIntoSentences('   ')).toEqual([])
  })
  it('handles single sentence without terminator', () => {
    expect(splitIntoSentences('Без крапки в кінці')).toEqual(['Без крапки в кінці'])
  })
})

describe('chunkText', () => {
  it('packs sentences greedily under max', () => {
    const text = 'A. B. C. D.'.repeat(1)
    const chunks = chunkText('Речення один. Речення два. Речення три.', 30)
    expect(chunks.join(' ')).toContain('Речення один')
    expect(chunks.every(c => c.length <= 30)).toBe(true)
  })
  it('single long sentence is hard-split', () => {
    const long = 'word '.repeat(500) + '.'
    const chunks = chunkText(long, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(c => c.length <= 200)).toBe(true)
  })
  it('preserves all content', () => {
    const text = 'One. Two. Three. Four five six. Seven.'
    const chunks = chunkText(text, 15)
    const joined = chunks.join(' ')
    for (const w of ['One', 'Two', 'Three', 'Four', 'five', 'six', 'Seven']) {
      expect(joined).toContain(w)
    }
  })
  it('returns empty array for empty text', () => {
    expect(chunkText('', 100)).toEqual([])
  })
})

describe('capChunks', () => {
  it('passes through under MAX_CHUNKS', () => {
    const arr = Array(5).fill('x')
    expect(capChunks(arr)).toEqual(arr)
  })
  it('truncates with [...] marker when over MAX_CHUNKS', () => {
    const arr = Array(MAX_CHUNKS + 5).fill('x')
    const out = capChunks(arr)
    expect(out.length).toBe(MAX_CHUNKS)
    expect(out[out.length - 1]).toBe('[...]')
  })
})

describe('isLongText', () => {
  it('true above threshold', () => {
    expect(isLongText('x'.repeat(LONG_TEXT_THRESHOLD + 1))).toBe(true)
  })
  it('false at/under threshold', () => {
    expect(isLongText('x'.repeat(LONG_TEXT_THRESHOLD))).toBe(false)
  })
})
