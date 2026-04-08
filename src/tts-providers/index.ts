import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { detectLanguage, cleanForSpeech, synthEdge } from './edge.js'
import { synthElevenLabs, hasActiveKey } from './elevenlabs.js'
import { chunkText, capChunks, MAX_EDGE_CHUNK, MAX_EL_CHUNK } from './chunking.js'

export type TtsProvider = 'edge' | 'elevenlabs' | 'auto'
export type TtsUseCase = 'reply' | 'tool'

/**
 * Resolve the TTS provider for a given use case:
 *   - 'reply'  → bot's automatic voice replies (TTS_PROVIDER_REPLY)
 *   - 'tool'   → agent-invoked TextToSpeech tool   (TTS_PROVIDER_TOOL)
 * Falls back to legacy `TTS_PROVIDER`, then to 'edge'.
 */
export function getProvider(useCase?: TtsUseCase): TtsProvider {
  const env = readEnvFile()
  const specific =
    useCase === 'reply' ? env['TTS_PROVIDER_REPLY'] :
    useCase === 'tool'  ? env['TTS_PROVIDER_TOOL']  :
    undefined
  const v = (specific ?? env['TTS_PROVIDER'] ?? 'edge').toLowerCase()
  if (v === 'elevenlabs' || v === 'auto') return v
  return 'edge'
}

export interface SynthesizeOptions {
  /** Force a specific provider, overriding env. Used after user confirms via inline keyboard. */
  forceProvider?: TtsProvider
  /** Which env-var slot to read provider from. Defaults to legacy TTS_PROVIDER. */
  useCase?: TtsUseCase
}

/**
 * Synthesize text to one or more mp3 files.
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

  if (provider === 'edge') return runEdge()

  // elevenlabs or auto
  if (!hasActiveKey()) {
    if (provider === 'auto') {
      logger.warn('No active ElevenLabs key, falling back to edge')
      return runEdge()
    }
    throw new Error('No active ElevenLabs key — add one in admin Audio tab')
  }

  try {
    return await runElevenLabs()
  } catch (err) {
    if (provider === 'auto') {
      logger.warn({ err: (err as Error).message }, 'elevenlabs failed, falling back to edge')
      return runEdge()
    }
    throw err
  }
}
