import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./db.js', () => ({
  getChatSetting: vi.fn(),
  setChatSetting: vi.fn(),
}))

import { getModelLabel, getModel, setModel, getTemperature, parseModelConfig, MODELS } from './model.js'
import { getChatSetting, setChatSetting } from './db.js'

describe('getModelLabel', () => {
  it('returns label for known model', () => {
    expect(getModelLabel('opus')).toBe('Opus 200k')
    expect(getModelLabel('opus-1m')).toBe('Opus 1M')
    expect(getModelLabel('sonnet')).toBe('Sonnet 200k')
    expect(getModelLabel('sonnet-1m')).toBe('Sonnet 1M')
    expect(getModelLabel('haiku')).toBe('Haiku')
  })

  it('returns id as fallback for unknown model', () => {
    expect(getModelLabel('unknown-model')).toBe('unknown-model')
  })
})

describe('MODELS', () => {
  it('has 5 models', () => {
    expect(MODELS).toHaveLength(5)
  })

  it('each model has id, label, description', () => {
    for (const m of MODELS) {
      expect(m.id).toBeTruthy()
      expect(m.label).toBeTruthy()
      expect(m.description).toBeTruthy()
    }
  })
})

describe('parseModelConfig', () => {
  it('parses 1m model', () => {
    expect(parseModelConfig('sonnet-1m')).toEqual({ model: 'sonnet', use1m: true })
    expect(parseModelConfig('opus-1m')).toEqual({ model: 'opus', use1m: true })
  })

  it('parses regular model', () => {
    expect(parseModelConfig('sonnet')).toEqual({ model: 'sonnet', use1m: false })
    expect(parseModelConfig('opus')).toEqual({ model: 'opus', use1m: false })
    expect(parseModelConfig('haiku')).toEqual({ model: 'haiku', use1m: false })
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
