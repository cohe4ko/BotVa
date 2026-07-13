/**
 * Gemini TTS — direct calls to the Generative Language API.
 * Uses GOOGLE_API_KEY (same key as GenerateImage/AskGemini). Free tier, supports Ukrainian.
 *
 * The API returns raw PCM (s16le, 24 kHz, mono, base64). Telegram voice messages
 * must be OGG/Opus or MP3, so we convert via ffmpeg; if ffmpeg is unavailable we
 * fall back to a WAV container (delivered as audio file instead of voice bubble).
 */

import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logger } from '../logger.js'
import { readEnvFile } from '../env.js'
import { UPLOADS_DIR } from '../media.js'

const execFileAsync = promisify(execFile)

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts'
const DEFAULT_VOICE = 'Charon'
const PCM_SAMPLE_RATE = 24000

export function hasGeminiKey(): boolean {
  const env = readEnvFile()
  return !!(env['GOOGLE_API_KEY'] || env['GEMINI_API_KEY'])
}

/** Wrap raw s16le mono PCM into a WAV container (44-byte RIFF header). */
export function pcmToWav(pcm: Buffer, sampleRate = PCM_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * 2 // mono, 16-bit
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)          // fmt chunk size
  header.writeUInt16LE(1, 20)           // PCM format
  header.writeUInt16LE(1, 22)           // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32)           // block align
  header.writeUInt16LE(16, 34)          // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Convert raw PCM to OGG/Opus via ffmpeg. Throws if ffmpeg is missing/broken. */
async function pcmToOgg(pcm: Buffer, outPath: string): Promise<void> {
  const rawPath = outPath.replace(/\.ogg$/, '.pcm')
  writeFileSync(rawPath, pcm)
  try {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-loglevel', 'error',
       '-f', 's16le', '-ar', String(PCM_SAMPLE_RATE), '-ac', '1', '-i', rawPath,
       '-c:a', 'libopus', '-b:a', '48k', outPath],
      { timeout: 30_000 },
    )
  } finally {
    try { unlinkSync(rawPath) } catch { /* ignore */ }
  }
}

export interface GeminiSynthOverrides {
  /** Voice name override (admin preview). Falls back to TTS_VOICE_GEMINI. */
  voice?: string
  /** Style instruction override (admin preview). Falls back to TTS_GEMINI_STYLE. */
  style?: string
}

/**
 * Synthesize a single chunk via Gemini TTS. Returns path to an ogg (or wav) file.
 * Throws on any error — orchestrator decides whether to fall back to Edge.
 * `lang` is unused: Gemini auto-detects language from the text itself.
 */
export async function synthGemini(
  text: string,
  _lang?: 'uk' | 'ru' | 'en',
  overrides: GeminiSynthOverrides = {},
): Promise<string> {
  const env = readEnvFile()
  const apiKey = env['GOOGLE_API_KEY'] || env['GEMINI_API_KEY']
  if (!apiKey) throw new Error('GOOGLE_API_KEY not set — Gemini TTS unavailable')

  const model = env['TTS_MODEL_GEMINI'] ?? DEFAULT_MODEL
  const voice = overrides.voice || (env['TTS_VOICE_GEMINI'] ?? DEFAULT_VOICE)
  // Optional style instruction prepended to the text, e.g. "Говори тепло і спокійно:"
  const style = overrides.style ?? env['TTS_GEMINI_STYLE']
  const prompt = style ? `${style} ${text}` : text

  const r = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  })

  if (!r.ok) {
    const errText = await r.text().catch(() => '')
    throw new Error(`Gemini TTS ${r.status}: ${errText.slice(0, 200)}`)
  }

  const d = await r.json() as any
  const inline = d?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData
  if (!inline?.data) throw new Error('Gemini TTS returned no audio data')
  const pcm = Buffer.from(inline.data, 'base64')
  if (pcm.length < 1000) throw new Error('Gemini TTS returned suspiciously small audio')

  const oggPath = join(UPLOADS_DIR, `tts_${Date.now()}.ogg`)
  try {
    await pcmToOgg(pcm, oggPath)
    logger.info({ voice, model, chars: text.length, outPath: oggPath }, 'Speech synthesized (gemini)')
    return oggPath
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'ffmpeg unavailable, falling back to WAV container')
    const wavPath = join(UPLOADS_DIR, `tts_${Date.now()}.wav`)
    writeFileSync(wavPath, pcmToWav(pcm))
    logger.info({ voice, model, chars: text.length, outPath: wavPath }, 'Speech synthesized (gemini, wav)')
    return wavPath
  }
}
