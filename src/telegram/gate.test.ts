import { describe, it, expect } from 'vitest'

import { gate, sectorFor, isDuplicate, AUTO_SAVE, DROP_BELOW, DUPLICATE_AT } from './gate.js'

describe('confidence gate', () => {
  it('drops what the model is not sure about', () => {
    const d = gate({ kind: 'facts', confidence: DROP_BELOW - 0.01, when_due: null })
    expect(d.action).toBe('drop')
  })

  it('saves a confident fact straight away', () => {
    const d = gate({ kind: 'facts', confidence: AUTO_SAVE, when_due: null })
    expect(d).toMatchObject({ action: 'save', reminder: false })
  })

  it('queues everything in between for a human', () => {
    const d = gate({ kind: 'facts', confidence: 0.6, when_due: null })
    expect(d.action).toBe('queue')
  })

  it('creates a reminder for a dated commitment', () => {
    const d = gate({ kind: 'commitments_mine', confidence: 0.9, when_due: '2026-09-10T15:00' })
    expect(d).toMatchObject({ action: 'save', reminder: true })
  })

  it('never invents a date for an undated task', () => {
    // Confident, but there is nothing to fire on. Guessing a deadline is worse
    // than asking, so it waits in the queue for a real one.
    const d = gate({ kind: 'commitments_mine', confidence: 0.95, when_due: null })
    expect(d).toMatchObject({ action: 'queue', reminder: false, why: 'нема дати' })
  })

  it('does not hold back an undated plain fact', () => {
    // The undated rule is about tasks only — a fact has nothing to fire.
    const d = gate({ kind: 'facts', confidence: 0.95, when_due: null })
    expect(d.action).toBe('save')
  })

  it('treats a request with a deadline as schedulable', () => {
    const d = gate({ kind: 'requests', confidence: 0.8, when_due: '2026-09-10' })
    expect(d.reminder).toBe(true)
  })
})

describe('sector', () => {
  it('files knowledge as semantic and happenings as episodic', () => {
    expect(sectorFor('facts')).toBe('semantic')
    expect(sectorFor('contacts')).toBe('semantic')
    expect(sectorFor('events')).toBe('episodic')
    expect(sectorFor('commitments_mine')).toBe('episodic')
  })
})

describe('duplicates', () => {
  it('recognises the same thing said again', () => {
    expect(isDuplicate(DUPLICATE_AT)).toBe(true)
    expect(isDuplicate(0.89)).toBe(false)
  })
})
