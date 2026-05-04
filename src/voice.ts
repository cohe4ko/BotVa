import { readFileSync, renameSync, statSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'fs'
import { basename, join, extname } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { logger } from './logger.js'
import { readEnvFile } from './env.js'
import { synthesize, type SynthesizeOptions } from './tts-providers/index.js'
import {
  pickKey, markUsed, markRateLimited, markError, parseRetryAfter,
  ensureMigrated, hasAnyKey, hasUsableKey, loadStore,
} from './groq-keys.js'

// Groq Whisper limits (api.groq.com docs):
//   - Free tier:  25 MB per request
//   - Dev tier:  100 MB per request
// We use a conservative ceiling so multipart overhead never tips us over.
const GROQ_FILE_LIMIT_BYTES = 24 * 1024 * 1024
// Time-based chunk length when we have to split. 16 kHz mono FLAC ≈ 13 KB/s,
// so 1500 s ≈ 19.5 MB — well under the limit even before re-encode jitter.
const CHUNK_SECONDS = 1500
// Formats Groq accepts directly. Anything else gets re-encoded to FLAC.
const SUPPORTED_EXTS = new Set([
  '.flac', '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.ogg', '.opus', '.wav', '.webm',
])

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

export async function transcribeAudio(filePath: string, opts: { language?: string } = {}): Promise<string> {
  migrateGroqFromEnv()

  // Rename .oga to .ogg (Groq requirement — same format, different extension)
  let actualPath = filePath
  if (filePath.endsWith('.oga')) {
    actualPath = filePath.replace(/\.oga$/, '.ogg')
    renameSync(filePath, actualPath)
  }

  const fileBuffer = readFileSync(actualPath)
  const filename = basename(actualPath)

  const mimeByExt: Record<string, string> = {
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.mp3': 'audio/mpeg',
    '.mp4': 'audio/mp4', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.flac': 'audio/flac', '.webm': 'audio/webm', '.opus': 'audio/opus',
    '.mpga': 'audio/mpeg', '.mpeg': 'audio/mpeg',
  }
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  const mimeType = mimeByExt[ext] ?? 'audio/ogg'
  const env = readEnvFile()
  const sttModel = env['GROQ_STT_MODEL'] ?? 'whisper-large-v3'
  const sttLang = opts.language ?? env['GROQ_STT_LANGUAGE'] // e.g. 'uk', 'ru', 'en' or unset for auto-detect
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
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
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

function runCmd(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('error', err => reject(err))
    proc.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function probeDuration(filePath: string): Promise<number | null> {
  try {
    const r = await runCmd('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ])
    if (r.code !== 0) return null
    const d = Number(r.stdout.trim())
    return Number.isFinite(d) && d > 0 ? d : null
  } catch {
    return null
  }
}

async function ffmpegAvailable(): Promise<boolean> {
  try {
    const r = await runCmd('ffmpeg', ['-version'])
    return r.code === 0
  } catch {
    return false
  }
}

/**
 * Split a long audio file into 16 kHz mono FLAC chunks of ≤ CHUNK_SECONDS each.
 * Returns absolute paths to chunks plus a cleanup() that removes the temp dir.
 */
async function splitForTranscription(filePath: string): Promise<{ chunks: string[]; cleanup: () => void }> {
  if (!(await ffmpegAvailable())) {
    throw new Error('Audio is too large or in an unsupported format and ffmpeg is not installed — cannot chunk')
  }
  const dir = mkdtempSync(join(tmpdir(), 'botva-stt-'))
  const pattern = join(dir, 'chunk_%04d.flac')
  const r = await runCmd('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac',
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    pattern,
  ])
  if (r.code !== 0) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`ffmpeg split failed: ${r.stderr.slice(0, 300)}`)
  }
  const chunks = readdirSync(dir)
    .filter(f => f.endsWith('.flac'))
    .sort()
    .map(f => join(dir, f))
  if (chunks.length === 0) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error('ffmpeg produced no chunks')
  }
  return {
    chunks,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} },
  }
}

export interface TranscribeLongResult {
  text: string
  chunks: number
  durationSec: number | null
  bytes: number
}

/**
 * Transcribe an audio file of any length. Small files in supported formats are
 * uploaded directly; oversized or exotic formats are re-encoded and split into
 * 16 kHz mono FLAC segments via ffmpeg, then transcripts are concatenated.
 */
export async function transcribeAudioLong(
  filePath: string,
  opts: { language?: string } = {},
): Promise<TranscribeLongResult> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
  const stat = statSync(filePath)
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
  const bytes = stat.size

  const ext = extname(filePath).toLowerCase()
  const supported = SUPPORTED_EXTS.has(ext) || ext === '.oga' // .oga is treated as .ogg by transcribeAudio
  const duration = await probeDuration(filePath)

  // Fast path: small enough and already in a Groq-supported format.
  if (bytes <= GROQ_FILE_LIMIT_BYTES && supported) {
    const text = await transcribeAudio(filePath, { language: opts.language })
    return { text, chunks: 1, durationSec: duration, bytes }
  }

  logger.info({ bytes, duration, ext }, 'Audio needs splitting for STT')
  const { chunks, cleanup } = await splitForTranscription(filePath)
  try {
    const parts: string[] = []
    for (const [i, chunkPath] of chunks.entries()) {
      logger.info({ chunk: i + 1, total: chunks.length }, 'Transcribing chunk')
      const text = await transcribeAudio(chunkPath, { language: opts.language })
      parts.push(text.trim())
    }
    return {
      text: parts.filter(Boolean).join(' '),
      chunks: chunks.length,
      durationSec: duration,
      bytes,
    }
  } finally {
    cleanup()
  }
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
