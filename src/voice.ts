import { readFileSync, renameSync } from 'fs'
import { basename } from 'path'
import { logger } from './logger.js'
import { readEnvFile } from './env.js'
import { synthesize, type SynthesizeOptions } from './tts-providers/index.js'
import {
  pickKey, markUsed, markRateLimited, markError, parseRetryAfter,
  ensureMigrated, hasAnyKey, hasUsableKey, loadStore,
} from './groq-keys.js'

/**
 * Migrate legacy per-bot GROQ_API_KEY / GROQ_API_KEYS from .env into the global
 * key store on first call. Idempotent — safe to call before every transcription.
 */
function migrateGroqFromEnv(): void {
  if (hasAnyKey()) return
  const env = readEnvFile()
  const candidates: Array<{ key: string; label?: string }> = []
  const multi = env['GROQ_API_KEYS']
  if (multi) {
    for (const [i, k] of multi.split(',').map(s => s.trim()).filter(Boolean).entries()) {
      candidates.push({ key: k, label: `env-${i + 1}` })
    }
  }
  const single = env['GROQ_API_KEY']
  if (single) candidates.push({ key: single, label: 'env-primary' })
  if (candidates.length > 0) {
    ensureMigrated(candidates)
    logger.info({ count: candidates.length }, 'Migrated Groq keys from .env to store')
  }
}

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  migrateGroqFromEnv()
  const env = readEnvFile()
  // Fall back to env check too, so capability reporting still works before first transcription.
  return {
    stt: hasAnyKey() || !!env['GROQ_API_KEY'] || !!env['GROQ_API_KEYS'],
    tts: true, // edge-tts is free, no key needed
  }
}

export async function transcribeAudio(filePath: string): Promise<string> {
  migrateGroqFromEnv()

  // Rename .oga to .ogg (Groq requirement — same format, different extension)
  let actualPath = filePath
  if (filePath.endsWith('.oga')) {
    actualPath = filePath.replace(/\.oga$/, '.ogg')
    renameSync(filePath, actualPath)
  }

  const fileBuffer = readFileSync(actualPath)
  const filename = basename(actualPath)
  const env = readEnvFile()
  const sttModel = env['GROQ_STT_MODEL'] ?? 'whisper-large-v3'
  const sttLang = env['GROQ_STT_LANGUAGE'] // e.g. 'uk', 'ru', 'en' or unset for auto-detect
  const sttPrompt = env['GROQ_STT_PROMPT'] ?? 'Розмова українською, російською або англійською мовою.'

  if (!hasUsableKey()) {
    if (!hasAnyKey()) throw new Error('No Groq API keys configured — add one in admin /audio or set GROQ_API_KEY in .env')
    throw new Error('All Groq keys rate-limited — wait for cooldown or add more in admin /audio')
  }

  const totalKeys = loadStore().keys.length
  let lastErr = ''

  // Try every key once. Any that 429s is marked rate-limited and skipped by subsequent pickKey() calls.
  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const picked = pickKey()
    if (!picked) break

    const boundary = `----FormBoundary${Date.now()}${attempt}`
    const parts: Buffer[] = []

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`
    ))
    parts.push(fileBuffer)
    parts.push(Buffer.from('\r\n'))

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${sttModel}\r\n`
    ))
    // verbose_json so we get `duration` for ASPH accounting.
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`
    ))
    if (sttLang) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${sttLang}\r\n`
      ))
    }
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${sttPrompt}\r\n`
    ))
    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    let response: Response
    try {
      response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${picked.key}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      })
    } catch (err) {
      lastErr = `network: ${(err as Error).message}`
      markError(picked.id, lastErr)
      continue
    }

    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after')) ?? undefined
      const errText = await response.text().catch(() => '')
      logger.warn({ key: picked.label, retryAfter, body: errText.slice(0, 200) }, 'Groq 429 — marking key rate-limited')
      markRateLimited(picked.id, retryAfter)
      lastErr = `429 [${picked.label}]`
      continue
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      lastErr = `${response.status}: ${errText.slice(0, 200)}`
      logger.error({ status: response.status, key: picked.label, body: errText }, 'Groq transcription failed')
      markError(picked.id, lastErr)
      continue
    }

    const data = await response.json() as { text?: string; duration?: number }
    if (!data?.text) {
      lastErr = 'empty response'
      markError(picked.id, lastErr)
      continue
    }
    const durationSec = Math.max(0, Math.round(Number(data.duration ?? 0)))
    markUsed(picked.id, durationSec)
    logger.info({ chars: data.text.length, duration: durationSec, key: picked.label }, 'Audio transcribed')
    return data.text
  }

  throw new Error(`Groq transcription failed: ${lastErr || 'all keys exhausted'}`)
}

/**
 * Synthesize text to one or more mp3 files. Long texts are split on sentence
 * boundaries across multiple files — the caller is expected to send each as
 * a separate voice message.
 */
export async function synthesizeSpeech(text: string, opts: SynthesizeOptions = {}): Promise<string[]> {
  try {
    return await synthesize(text, opts)
  } catch (err) {
    logger.error({ err }, 'TTS failed')
    throw new Error(`TTS failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
