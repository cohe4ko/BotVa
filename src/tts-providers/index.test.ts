import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../media.js', () => ({ UPLOADS_DIR: '/tmp' }))
vi.mock('./edge.js', async () => {
  const actual = await vi.importActual<typeof import('./edge.js')>('./edge.js')
  return { ...actual, synthEdge: vi.fn(async () => '/tmp/edge.mp3') }
})
vi.mock('./elevenlabs.js', () => ({
  synthElevenLabs: vi.fn(),
  hasActiveKey: vi.fn(),
}))
vi.mock('./gemini.js', () => ({
  synthGemini: vi.fn(),
  hasGeminiKey: vi.fn(),
}))

import { readEnvFile } from '../env.js'
import { synthEdge } from './edge.js'
import { synthElevenLabs, hasActiveKey } from './elevenlabs.js'
import { synthGemini, hasGeminiKey } from './gemini.js'
import { synthesize, getProvider } from './index.js'

const readEnvMock = readEnvFile as unknown as ReturnType<typeof vi.fn>
const synthEdgeMock = synthEdge as unknown as ReturnType<typeof vi.fn>
const synthElMock = synthElevenLabs as unknown as ReturnType<typeof vi.fn>
const getWorkerCfgMock = hasActiveKey as unknown as ReturnType<typeof vi.fn>
const synthGeminiMock = synthGemini as unknown as ReturnType<typeof vi.fn>
const hasGeminiKeyMock = hasGeminiKey as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  readEnvMock.mockReset().mockReturnValue({})
  synthEdgeMock.mockReset().mockResolvedValue('/tmp/edge.mp3')
  synthElMock.mockReset()
  getWorkerCfgMock.mockReset()
  synthGeminiMock.mockReset().mockResolvedValue('/tmp/gemini.ogg')
  hasGeminiKeyMock.mockReset().mockReturnValue(true)
})

describe('getProvider', () => {
  it('defaults to gemini', () => {
    readEnvMock.mockReturnValue({})
    expect(getProvider()).toBe('gemini')
  })
  it('reads elevenlabs/auto', () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'auto' })
    expect(getProvider()).toBe('auto')
  })
  it('reads edge', () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'edge' })
    expect(getProvider()).toBe('edge')
  })
  it('falls back to gemini for unknown', () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'garbage' })
    expect(getProvider()).toBe('gemini')
  })
})

describe('synthesize', () => {
  it('throws on empty text', async () => {
    await expect(synthesize('   ')).rejects.toThrow(/Nothing to synthesize/)
  })

  it('uses edge when provider=edge', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'edge' })
    const p = await synthesize('Привіт світ')
    expect(p).toEqual(['/tmp/edge.mp3'])
    expect(synthEdgeMock).toHaveBeenCalled()
    expect(synthElMock).not.toHaveBeenCalled()
    expect(synthGeminiMock).not.toHaveBeenCalled()
  })

  it('uses gemini by default', async () => {
    readEnvMock.mockReturnValue({})
    const p = await synthesize('Привіт світ')
    expect(p).toEqual(['/tmp/gemini.ogg'])
    expect(synthGeminiMock).toHaveBeenCalled()
    expect(synthEdgeMock).not.toHaveBeenCalled()
  })

  it('gemini falls back to edge when no google key', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'gemini' })
    hasGeminiKeyMock.mockReturnValue(false)
    const p = await synthesize('Привіт')
    expect(p).toEqual(['/tmp/edge.mp3'])
    expect(synthGeminiMock).not.toHaveBeenCalled()
  })

  it('gemini falls back to edge on synth failure', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'gemini' })
    synthGeminiMock.mockRejectedValue(new Error('429 quota'))
    const p = await synthesize('Привіт')
    expect(p).toEqual(['/tmp/edge.mp3'])
  })

  it('uses elevenlabs when provider=elevenlabs and worker configured', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'elevenlabs' })
    getWorkerCfgMock.mockReturnValue(true)
    synthElMock.mockResolvedValue('/tmp/el.mp3')
    const p = await synthesize('Привіт')
    expect(p).toEqual(['/tmp/el.mp3'])
    expect(synthEdgeMock).not.toHaveBeenCalled()
  })

  it('auto falls back to gemini when no active EL key', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'auto' })
    getWorkerCfgMock.mockReturnValue(false)
    const p = await synthesize('Привіт')
    expect(p).toEqual(['/tmp/gemini.ogg'])
  })

  it('auto falls back to edge when no EL key and no google key', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'auto' })
    getWorkerCfgMock.mockReturnValue(false)
    hasGeminiKeyMock.mockReturnValue(false)
    const p = await synthesize('Привіт')
    expect(p).toEqual(['/tmp/edge.mp3'])
    expect(synthEdgeMock).toHaveBeenCalled()
  })

  it('auto falls back to gemini when elevenlabs throws', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'auto' })
    getWorkerCfgMock.mockReturnValue(true)
    synthElMock.mockRejectedValue(new Error('503 no_keys'))
    const p = await synthesize('Привіт')
    expect(p).toEqual(['/tmp/gemini.ogg'])
  })

  it('auto cascades to edge when both elevenlabs and gemini throw', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'auto' })
    getWorkerCfgMock.mockReturnValue(true)
    synthElMock.mockRejectedValue(new Error('503 no_keys'))
    synthGeminiMock.mockRejectedValue(new Error('429 quota'))
    const p = await synthesize('Привіт')
    expect(p).toEqual(['/tmp/edge.mp3'])
  })

  it('elevenlabs (strict) rethrows on worker failure', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'elevenlabs' })
    getWorkerCfgMock.mockReturnValue(true)
    synthElMock.mockRejectedValue(new Error('boom'))
    await expect(synthesize('Привіт')).rejects.toThrow(/boom/)
  })

  it('elevenlabs (strict) throws when no active key', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'elevenlabs' })
    getWorkerCfgMock.mockReturnValue(false)
    await expect(synthesize('Привіт')).rejects.toThrow(/No active ElevenLabs key/)
  })
})
