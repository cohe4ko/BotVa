import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { detectLanguage, cleanForSpeech, synthEdge } from './edge.js'
import { synthElevenLabs, hasActiveKey } from './elevenlabs.js'
import { synthGemini, hasGeminiKey } from './gemini.js'
import { chunkText, capChunks, MAX_EDGE_CHUNK, MAX_EL_CHUNK, MAX_GEMINI_CHUNK } from './chunking.js'

export type TtsProvider = 'edge' | 'elevenlabs' | 'gemini' | 'auto'
export type TtsUseCase = 'reply' | 'tool'

/**
 * Resolve the TTS provider for a given use case:
 *   - 'reply'  → bot's automatic voice replies (TTS_PROVIDER_REPLY)
 *   - 'tool'   → agent-invoked TextToSpeech tool   (TTS_PROVIDER_TOOL)
 * Falls back to legacy `TTS_PROVIDER`, then to 'gemini' (free tier, Ukrainian support).
 */
export function getProvider(useCase?: TtsUseCase): TtsProvider {
  const env = readEnvFile()
  const specific =
    useCase === 'reply' ? env['TTS_PROVIDER_REPLY'] :
    useCase === 'tool'  ? env['TTS_PROVIDER_TOOL']  :
    undefined
  const v = (specific ?? env['TTS_PROVIDER'] ?? 'gemini').toLowerCase()
  if (v === 'elevenlabs' || v === 'auto' || v === 'edge') return v
  return 'gemini'
}

export interface SynthesizeOptions {
  /** Force a specific provider, overriding env. Used after user confirms via inline keyboard. */
  forceProvider?: TtsProvider
  /** Which env-var slot to read provider from. Defaults to legacy TTS_PROVIDER. */
  useCase?: TtsUseCase
  /**
   * Per-message speaking-style instruction (emotional tone), e.g. "радісно і енергійно".
   * Agent-provided via [[tone: ...]] marker or the TextToSpeech tool's `tone` param.
   * Only Gemini honours it; Edge/ElevenLabs ignore.
   */
  styleOverride?: string
}

/**
 * Extract the agent-provided voice tone marker `[[tone: ...]]` from a reply.
 * Returns the text with ALL markers stripped and the first marker's value.
 * The marker is TTS metadata — it must never reach the user or memory.
 */
export function extractToneMarker(raw: string): { text: string; tone?: string } {
  const m = raw.match(/\[\[\s*tone:\s*([^\]]+?)\s*\]\]/i)
  if (!m) return { text: raw }
  const text = raw.replace(/[ \t]*\[\[\s*tone:[^\]]*\]\][ \t]*/gi, '').replace(/\n{3,}/g, '\n\n').trim()
  return { text, tone: m[1].trim() }
}

/**
 * Synthesize text to one or more audio files (mp3 for edge/elevenlabs, ogg for gemini).
 * Long texts are split on sentence boundaries and returned as multiple paths,
 * so the caller (bot.ts or TextToSpeech tool) can send them as sequential voice messages.
 */
export async function synthesize(text: string, opts: SynthesizeOptions = {}): Promise<string[]> {
  const clean = cleanForSpeech(text)
  if (!clean || clean.length < 2) throw new Error('Nothing to synthesize')
  const lang = detectLanguage(clean)
  const provider = opts.forceProvider ?? getProvider(opts.useCase)

  const runEdge = async (): Promise<string[]> => {
    const chunks = capChunks(chunkText(clean, MAX_EDGE_CHUNK))
    const paths: string[] = []
    for (const c of chunks) paths.push(await synthEdge(c, lang))
    return paths
  }

  const runElevenLabs = async (): Promise<string[]> => {
    const chunks = capChunks(chunkText(clean, MAX_EL_CHUNK))
    const paths: string[] = []
    for (const c of chunks) paths.push(await synthElevenLabs(c, lang))
    return paths
  }

  const runGemini = async (): Promise<string[]> => {
    const chunks = capChunks(chunkText(clean, MAX_GEMINI_CHUNK))
    const paths: string[] = []
    for (const c of chunks) paths.push(await synthGemini(c, lang, { style: opts.styleOverride }))
    return paths
  }

  if (provider === 'edge') return runEdge()

  if (provider === 'gemini') {
    if (!hasGeminiKey()) {
      logger.warn('No GOOGLE_API_KEY, falling back to edge')
      return runEdge()
    }
    try {
      return await runGemini()
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'gemini failed, falling back to edge')
      return runEdge()
    }
  }

  // elevenlabs or auto
  if (!hasActiveKey()) {
    if (provider === 'auto') {
      logger.warn('No active ElevenLabs key, falling back to gemini/edge')
      return hasGeminiKey()
        ? runGemini().catch(() => runEdge())
        : runEdge()
    }
    throw new Error('No active ElevenLabs key — add one in admin Audio tab')
  }

  try {
    return await runElevenLabs()
  } catch (err) {
    if (provider === 'auto') {
      logger.warn({ err: (err as Error).message }, 'elevenlabs failed, falling back to gemini/edge')
      return hasGeminiKey()
        ? runGemini().catch(() => runEdge())
        : runEdge()
    }
    throw err
  }
}
