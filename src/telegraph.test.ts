import { describe, it, expect, vi } from 'vitest'

vi.mock('./config.js', () => ({
  STORE_DIR: '/tmp/botva-test',
  BOT_NAME: 'TestBot',
}))

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { shouldUseTelegraph } from './telegraph.js'

describe('shouldUseTelegraph', () => {
  it('returns false for short text', () => {
    expect(shouldUseTelegraph('Hello world')).toBe(false)
  })

  it('returns false for text at threshold', () => {
    const text = 'a'.repeat(2000)
    expect(shouldUseTelegraph(text)).toBe(false)
  })

  it('returns true for text over threshold', () => {
    const text = 'a'.repeat(2001)
    expect(shouldUseTelegraph(text)).toBe(true)
  })
})
