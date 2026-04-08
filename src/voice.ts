import { readFileSync, renameSync } from 'fs'
import { basename } from 'path'
import { logger } from './logger.js'
import { readEnvFile } from './env.js'
import { synthesize, type SynthesizeOptions } from './tts-providers/index.js'

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

  const data = await response.json() as { text?: string }
  if (!data?.text) throw new Error('Groq STT returned no text: ' + JSON.stringify(data))
  logger.info({ chars: data.text.length }, 'Audio transcribed')
  return data.text
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
