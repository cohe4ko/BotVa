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

import { readEnvFile } from '../env.js'
import { synthEdge } from './edge.js'
import { synthElevenLabs, hasActiveKey } from './elevenlabs.js'
import { synthesize, getProvider } from './index.js'

const readEnvMock = readEnvFile as unknown as ReturnType<typeof vi.fn>
const synthEdgeMock = synthEdge as unknown as ReturnType<typeof vi.fn>
const synthElMock = synthElevenLabs as unknown as ReturnType<typeof vi.fn>
const getWorkerCfgMock = hasActiveKey as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  readEnvMock.mockReset().mockReturnValue({})
  synthEdgeMock.mockReset().mockResolvedValue('/tmp/edge.mp3')
  synthElMock.mockReset()
  getWorkerCfgMock.mockReset()
})

describe('getProvider', () => {
  it('defaults to edge', () => {
    readEnvMock.mockReturnValue({})
    expect(getProvider()).toBe('edge')
  })
  it('reads elevenlabs/auto', () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'auto' })
    expect(getProvider()).toBe('auto')
  })
  it('falls back to edge for unknown', () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'garbage' })
    expect(getProvider()).toBe('edge')
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
  })

  it('uses elevenlabs when provider=elevenlabs and worker configured', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'elevenlabs' })
    getWorkerCfgMock.mockReturnValue(true)
    synthElMock.mockResolvedValue('/tmp/el.mp3')
    const p = await synthesize('Привіт')
    expect(p).toEqual(['/tmp/el.mp3'])
    expect(synthEdgeMock).not.toHaveBeenCalled()
  })

  it('auto falls back to edge when no active key', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'auto' })
    getWorkerCfgMock.mockReturnValue(false)
    const p = await synthesize('Привіт')
    expect(p).toEqual(['/tmp/edge.mp3'])
    expect(synthEdgeMock).toHaveBeenCalled()
  })

  it('auto falls back to edge when elevenlabs throws', async () => {
    readEnvMock.mockReturnValue({ TTS_PROVIDER: 'auto' })
    getWorkerCfgMock.mockReturnValue(true)
    synthElMock.mockRejectedValue(new Error('503 no_keys'))
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
