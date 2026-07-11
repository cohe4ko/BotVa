import { describe, it, expect, vi } from 'vitest'

vi.mock('./config.js', () => ({ MAX_MESSAGE_LENGTH: 4096 }))

import { shouldOfferTelegraphButton, TELEGRAPH_BUTTON_THRESHOLD } from './message-format.js'

describe('shouldOfferTelegraphButton', () => {
  it('threshold is 5000', () => {
    expect(TELEGRAPH_BUTTON_THRESHOLD).toBe(5000)
  })

  it('returns false for short and at-threshold texts', () => {
    expect(shouldOfferTelegraphButton('')).toBe(false)
    expect(shouldOfferTelegraphButton('a'.repeat(100))).toBe(false)
    expect(shouldOfferTelegraphButton('a'.repeat(TELEGRAPH_BUTTON_THRESHOLD))).toBe(false)
  })

  it('returns true only above the threshold', () => {
    expect(shouldOfferTelegraphButton('a'.repeat(TELEGRAPH_BUTTON_THRESHOLD + 1))).toBe(true)
    expect(shouldOfferTelegraphButton('a'.repeat(10000))).toBe(true)
  })
})
