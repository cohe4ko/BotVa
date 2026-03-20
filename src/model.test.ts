import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./db.js', () => ({
  getChatSetting: vi.fn(),
  setChatSetting: vi.fn(),
}))

import { getModelLabel, getModel, setModel, getTemperature, MODELS } from './model.js'
import { getChatSetting, setChatSetting } from './db.js'

describe('getModelLabel', () => {
  it('returns label for known model', () => {
    expect(getModelLabel('opus')).toBe('Opus')
    expect(getModelLabel('sonnet')).toBe('Sonnet')
    expect(getModelLabel('haiku')).toBe('Haiku')
  })

  it('returns id as fallback for unknown model', () => {
    expect(getModelLabel('unknown-model')).toBe('unknown-model')
  })
})

describe('MODELS', () => {
  it('has 3 models', () => {
    expect(MODELS).toHaveLength(3)
  })

  it('each model has id, label, description', () => {
    for (const m of MODELS) {
      expect(m.id).toBeTruthy()
      expect(m.label).toBeTruthy()
      expect(m.description).toBeTruthy()
    }
  })
})

describe('getModel', () => {
  beforeEach(() => {
    vi.mocked(getChatSetting).mockReset()
  })

  it('returns default "sonnet" when no setting', () => {
    vi.mocked(getChatSetting).mockReturnValue(undefined)
    // Need fresh import to reset cache, but for simplicity test with a unique chatId
    expect(getModel('test-no-setting')).toBe('sonnet')
  })

  it('returns stored model from DB', () => {
    vi.mocked(getChatSetting).mockReturnValue('opus')
    expect(getModel('test-opus-chat')).toBe('opus')
  })
})

describe('getTemperature', () => {
  beforeEach(() => {
    vi.mocked(getChatSetting).mockReset()
  })

  it('returns undefined when no setting', () => {
    vi.mocked(getChatSetting).mockReturnValue(undefined)
    expect(getTemperature('chat1')).toBeUndefined()
  })

  it('returns parsed number', () => {
    vi.mocked(getChatSetting).mockReturnValue('0.7')
    expect(getTemperature('chat2')).toBe(0.7)
  })

  it('returns undefined for non-numeric value', () => {
    vi.mocked(getChatSetting).mockReturnValue('abc')
    expect(getTemperature('chat3')).toBeUndefined()
  })
})
