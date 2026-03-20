import { describe, it, expect } from 'vitest'

// We can't easily test classifyReaction (needs embeddings service),
// but we can test the EMOJI_DESCRIPTORS data integrity by importing the module
// and checking the exported function's edge cases.

// Import the module to check data integrity
// auto-react.ts exports classifyReaction — we test its guard clauses
import { vi } from 'vitest'

vi.mock('./embeddings.js', () => ({
  embed: vi.fn(() => null),
  embedBatch: vi.fn(() => []),
  cosineSim: vi.fn(() => 0),
}))

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { classifyReaction } from './auto-react.js'

describe('classifyReaction guard clauses', () => {
  it('returns null for empty message', async () => {
    expect(await classifyReaction('')).toBeNull()
  })

  it('returns null for command messages', async () => {
    expect(await classifyReaction('/start')).toBeNull()
    expect(await classifyReaction('/help')).toBeNull()
  })

  it('returns null for too long message', async () => {
    const longMsg = 'a'.repeat(201)
    expect(await classifyReaction(longMsg)).toBeNull()
  })

  it('returns null when embeddings return null', async () => {
    // embed mock returns null, so no match possible
    expect(await classifyReaction('hello world')).toBeNull()
  })
})
