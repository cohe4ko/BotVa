import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../media.js', () => ({ UPLOADS_DIR: '/tmp' }))

import { readEnvFile } from '../env.js'
import { hasGeminiKey, pcmToWav, synthGemini } from './gemini.js'

const readEnvMock = readEnvFile as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  readEnvMock.mockReset().mockReturnValue({})
})

describe('hasGeminiKey', () => {
  it('false without keys', () => {
    expect(hasGeminiKey()).toBe(false)
  })
  it('true with GOOGLE_API_KEY', () => {
    readEnvMock.mockReturnValue({ GOOGLE_API_KEY: 'k' })
    expect(hasGeminiKey()).toBe(true)
  })
  it('true with GEMINI_API_KEY', () => {
    readEnvMock.mockReturnValue({ GEMINI_API_KEY: 'k' })
    expect(hasGeminiKey()).toBe(true)
  })
  it('true with dedicated TTS_GEMINI_API_KEY', () => {
    readEnvMock.mockReturnValue({ TTS_GEMINI_API_KEY: 'k' })
    expect(hasGeminiKey()).toBe(true)
  })
})

describe('pcmToWav', () => {
  it('produces a valid RIFF header for s16le mono', () => {
    const pcm = Buffer.alloc(4800) // 0.1s at 24kHz 16-bit
    const wav = pcmToWav(pcm)
    expect(wav.length).toBe(44 + pcm.length)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length)
    expect(wav.readUInt16LE(22)).toBe(1)       // mono
    expect(wav.readUInt32LE(24)).toBe(24000)   // sample rate
    expect(wav.readUInt16LE(34)).toBe(16)      // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length)
  })
})

describe('synthGemini', () => {
  it('throws without api key', async () => {
    await expect(synthGemini('Привіт')).rejects.toThrow(/GOOGLE_API_KEY/)
  })

  it('throws on API error status', async () => {
    readEnvMock.mockReturnValue({ GOOGLE_API_KEY: 'k' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 429 })))
    await expect(synthGemini('Привіт')).rejects.toThrow(/Gemini TTS 429/)
    vi.unstubAllGlobals()
  })

  it('throws when response has no audio', async () => {
    readEnvMock.mockReturnValue({ GOOGLE_API_KEY: 'k' })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'oops' }] } }] }), { status: 200 })))
    await expect(synthGemini('Привіт')).rejects.toThrow(/no audio/)
    vi.unstubAllGlobals()
  })
})
