import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logger } from './logger.js'
import { readEnvFile } from './env.js'
import { UPLOADS_DIR } from './media.js'

const execFileAsync = promisify(execFile)

const VOICE_MAP: Record<string, string> = {
  uk: 'uk-UA-OstapNeural',
  ru: 'ru-RU-DmitryNeural',
  en: 'en-US-AndrewNeural',
}

function detectLanguage(text: string): 'uk' | 'ru' | 'en' {
  // Count character ranges
  const cyrillic = text.match(/[\u0400-\u04FF]/g)?.length ?? 0
  const latin = text.match(/[a-zA-Z]/g)?.length ?? 0

  if (latin > cyrillic) return 'en'

  // Ukrainian-specific letters: ії єє ґґ
  const ukSpecific = text.match(/[іїєґІЇЄҐ]/g)?.length ?? 0
  // Russian-specific letters: ыэёъ
  const ruSpecific = text.match(/[ыэёъЫЭЁЪ]/g)?.length ?? 0

  if (ukSpecific > ruSpecific) return 'uk'
  if (ruSpecific > ukSpecific) return 'ru'

  // Default to Ukrainian
  return 'uk'
}

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  const env = readEnvFile()
  return {
    stt: !!env['GROQ_API_KEY'],
    tts: true, // edge-tts is free, no key needed
  }
}

export async function transcribeAudio(filePath: string): Promise<string> {
  const env = readEnvFile()
  const apiKey = env['GROQ_API_KEY']
  if (!apiKey) throw new Error('GROQ_API_KEY not configured')

  // Rename .oga to .ogg (Groq requirement — same format, different extension)
  let actualPath = filePath
  if (filePath.endsWith('.oga')) {
    actualPath = filePath.replace(/\.oga$/, '.ogg')
    renameSync(filePath, actualPath)
  }

  const fileBuffer = readFileSync(actualPath)
  const filename = basename(actualPath)
  const boundary = `----FormBoundary${Date.now()}`

  const parts: Buffer[] = []

  // file field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`
  ))
  parts.push(fileBuffer)
  parts.push(Buffer.from('\r\n'))

  // model field
  const sttModel = env['GROQ_STT_MODEL'] ?? 'whisper-large-v3'
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${sttModel}\r\n`
  ))

  // language hint: if set, forces single language; if empty, Whisper auto-detects
  const sttLang = env['GROQ_STT_LANGUAGE'] // e.g. 'uk', 'ru', 'en' or unset for auto-detect
  if (sttLang) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${sttLang}\r\n`
    ))
  }

  // prompt helps Whisper with expected languages and context
  const sttPrompt = env['GROQ_STT_PROMPT'] ?? 'Розмова українською, російською або англійською мовою.'
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${sttPrompt}\r\n`
  ))

  parts.push(Buffer.from(`--${boundary}--\r\n`))

  const body = Buffer.concat(parts)

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  })

  if (!response.ok) {
    const errText = await response.text()
    logger.error({ status: response.status, body: errText }, 'Groq transcription failed')
    throw new Error(`Groq transcription failed: ${response.status}`)
  }

  const data = await response.json() as { text: string }
  logger.info({ chars: data.text.length }, 'Audio transcribed')
  return data.text
}

export async function synthesizeSpeech(text: string): Promise<string> {
  const env = readEnvFile()
  const lang = detectLanguage(text)
  const voice = env[`TTS_VOICE_${lang.toUpperCase()}`] ?? VOICE_MAP[lang]
  const outPath = join(UPLOADS_DIR, `tts_${Date.now()}.mp3`)

  // Strip markdown/HTML for cleaner speech
  const cleanText = text
    .replace(/```[\s\S]*?```/g, '') // remove code blocks
    .replace(/`[^`]+`/g, '')        // remove inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links -> text
    .replace(/<[^>]+>/g, '')        // strip HTML
    .replace(/[#*_~]+/g, '')        // strip markdown formatting
    .replace(/\n{2,}/g, '. ')       // paragraph breaks -> pause
    .replace(/\n/g, ' ')
    .trim()

  if (!cleanText || cleanText.length < 2) throw new Error('Nothing to synthesize')

  // Limit to ~4000 chars (edge-tts handles long text but let's be safe)
  const truncated = cleanText.length > 4000 ? cleanText.slice(0, 4000) + '...' : cleanText

  // Write text to temp file to avoid shell escaping issues
  const textFile = join(UPLOADS_DIR, `tts_text_${Date.now()}.txt`)

  try {
    writeFileSync(textFile, truncated, 'utf-8')

    const rate = env['TTS_RATE'] ?? '+30%'
    await execFileAsync('edge-tts', [
      '--voice', voice,
      '--rate', rate,
      '-f', textFile,
      '--write-media', outPath,
    ], { timeout: 30_000 })

    if (!existsSync(outPath)) {
      throw new Error('edge-tts produced no output')
    }

    logger.info({ voice, chars: truncated.length, outPath }, 'Speech synthesized')
    return outPath
  } catch (err) {
    logger.error({ err }, 'edge-tts failed')
    throw new Error(`TTS failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    try { unlinkSync(textFile) } catch { /* ignore */ }
  }
}
