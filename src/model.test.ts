import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./db.js', () => ({
  getChatSetting: vi.fn(),
  setChatSetting: vi.fn(),
}))

import {
  getModelLabel,
  getModel,
  setModel,
  getBackgroundModel,
  setBackgroundModel,
  getEffort,
  setEffort,
  parseModelConfig,
  getFallbackModel,
  MODELS,
  EFFORTS,
} from './model.js'
import { getChatSetting, setChatSetting } from './db.js'

describe('getModelLabel', () => {
  it('returns label for known model', () => {
    expect(getModelLabel('fable')).toBe('Fable 5')
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
  it('has 6 models', () => {
    expect(MODELS).toHaveLength(6)
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
  it('parses 1m model — adds [1m] suffix to model name', () => {
    expect(parseModelConfig('sonnet-1m')).toEqual({ model: 'sonnet[1m]', use1m: true })
    expect(parseModelConfig('opus-1m')).toEqual({ model: 'opus[1m]', use1m: true })
  })

  it('parses regular model', () => {
    expect(parseModelConfig('fable')).toEqual({ model: 'fable', use1m: false })
    expect(parseModelConfig('sonnet')).toEqual({ model: 'sonnet', use1m: false })
    expect(parseModelConfig('opus')).toEqual({ model: 'opus', use1m: false })
    expect(parseModelConfig('haiku')).toEqual({ model: 'haiku', use1m: false })
  })
})

describe('getFallbackModel', () => {
  it('maps each tier to the next lower one by availability', () => {
    expect(getFallbackModel('fable')).toBe('sonnet')
    expect(getFallbackModel('opus')).toBe('sonnet')
    expect(getFallbackModel('sonnet')).toBe('haiku')
  })

  it('returns undefined for the lowest tier', () => {
    expect(getFallbackModel('haiku')).toBeUndefined()
  })

  it('strips [1m] and -1m suffixes — fallback keeps plain name', () => {
    expect(getFallbackModel('opus[1m]')).toBe('sonnet')
    expect(getFallbackModel('opus-1m')).toBe('sonnet')
    expect(getFallbackModel('sonnet[1m]')).toBe('haiku')
    expect(getFallbackModel('sonnet-1m')).toBe('haiku')
  })

  it('returns undefined for unknown models', () => {
    expect(getFallbackModel('unknown-model')).toBeUndefined()
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

describe('getBackgroundModel', () => {
  beforeEach(() => {
    vi.mocked(getChatSetting).mockReset()
  })

  it('returns default "sonnet" when no setting', () => {
    vi.mocked(getChatSetting).mockReturnValue(undefined)
    expect(getBackgroundModel('bg-no-setting')).toBe('sonnet')
  })

  it('returns stored background model from DB', () => {
    vi.mocked(getChatSetting).mockImplementation((_chatId, key) =>
      key === 'background_model' ? 'haiku' : undefined,
    )
    expect(getBackgroundModel('bg-haiku-chat')).toBe('haiku')
  })

  it('caches the value after first read', () => {
    vi.mocked(getChatSetting).mockReturnValueOnce('opus')
    expect(getBackgroundModel('bg-cache-chat')).toBe('opus')
    // Subsequent calls should use cache even if DB is reset
    vi.mocked(getChatSetting).mockReturnValue(undefined)
    expect(getBackgroundModel('bg-cache-chat')).toBe('opus')
  })
})

describe('setBackgroundModel', () => {
  beforeEach(() => {
    vi.mocked(setChatSetting).mockReset()
  })

  it('persists to DB and updates cache', () => {
    setBackgroundModel('bg-set-chat', 'opus-1m')
    expect(setChatSetting).toHaveBeenCalledWith('bg-set-chat', 'background_model', 'opus-1m')
    expect(getBackgroundModel('bg-set-chat')).toBe('opus-1m')
  })
})

describe('getEffort', () => {
  beforeEach(() => {
    vi.mocked(getChatSetting).mockReset()
  })

  it('returns undefined when no setting', () => {
    vi.mocked(getChatSetting).mockReturnValue(undefined)
    expect(getEffort('eff-no-setting')).toBeUndefined()
  })

  it('returns undefined for empty string (explicit "use SDK default")', () => {
    vi.mocked(getChatSetting).mockReturnValue('')
    expect(getEffort('eff-empty')).toBeUndefined()
  })

  it('returns valid effort levels', () => {
    for (const level of EFFORTS) {
      vi.mocked(getChatSetting).mockReturnValue(level)
      expect(getEffort(`eff-${level}`)).toBe(level)
    }
  })

  it('returns undefined for invalid value', () => {
    vi.mocked(getChatSetting).mockReturnValue('turbo')
    expect(getEffort('eff-invalid')).toBeUndefined()
  })
})

describe('setEffort', () => {
  beforeEach(() => {
    vi.mocked(setChatSetting).mockReset()
  })

  it('persists effort level to DB', () => {
    setEffort('eff-set-high', 'high')
    expect(setChatSetting).toHaveBeenCalledWith('eff-set-high', 'effort', 'high')
  })

  it('persists empty string to clear effort', () => {
    setEffort('eff-set-clear', '')
    expect(setChatSetting).toHaveBeenCalledWith('eff-set-clear', 'effort', '')
  })
})
