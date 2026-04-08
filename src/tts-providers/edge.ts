import { writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logger } from '../logger.js'
import { readEnvFile } from '../env.js'
import { UPLOADS_DIR } from '../media.js'

const execFileAsync = promisify(execFile)

const DEFAULT_VOICES: Record<string, string> = {
  uk: 'uk-UA-OstapNeural',
  ru: 'ru-RU-DmitryNeural',
  en: 'en-US-AndrewNeural',
}

export function detectLanguage(text: string): 'uk' | 'ru' | 'en' {
  const cyrillic = text.match(/[\u0400-\u04FF]/g)?.length ?? 0
  const latin = text.match(/[a-zA-Z]/g)?.length ?? 0
  if (latin > cyrillic) return 'en'
  const ukSpecific = text.match(/[іїєґІЇЄҐ]/g)?.length ?? 0
  const ruSpecific = text.match(/[ыэёъЫЭЁЪ]/g)?.length ?? 0
  if (ukSpecific > ruSpecific) return 'uk'
  if (ruSpecific > ukSpecific) return 'ru'
  return 'uk'
}

export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[#*_~]+/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim()
}

export async function synthEdge(
  text: string,
  lang: 'uk' | 'ru' | 'en',
): Promise<string> {
  const env = readEnvFile()
  // NOTE: do NOT fall back to TTS_VOICE_{LANG} — that slot is now used for ElevenLabs
  // voice ids (stored in root .env via the Audio admin tab). Edge must use its own
  // override (TTS_VOICE_EDGE_{LANG}) or DEFAULT_VOICES.
  const voice = env[`TTS_VOICE_EDGE_${lang.toUpperCase()}`] ?? DEFAULT_VOICES[lang]
  const outPath = join(UPLOADS_DIR, `tts_${Date.now()}.mp3`)
  const textFile = join(UPLOADS_DIR, `tts_text_${Date.now()}.txt`)
  try {
    writeFileSync(textFile, text, 'utf-8')
    const rate = env['TTS_RATE'] ?? '+30%'
    await execFileAsync(
      'edge-tts',
      ['--voice', voice, '--rate', rate, '-f', textFile, '--write-media', outPath],
      { timeout: 30_000 },
    )
    if (!existsSync(outPath)) throw new Error('edge-tts produced no output')
    logger.info({ voice, chars: text.length, outPath }, 'Speech synthesized (edge)')
    return outPath
  } finally {
    try { unlinkSync(textFile) } catch { /* ignore */ }
  }
}
