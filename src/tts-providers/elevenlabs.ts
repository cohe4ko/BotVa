/**
 * ElevenLabs TTS — direct calls from BotVa (no Cloudflare Worker relay).
 * Uses the active key from key-store.ts. Rotation is manual via admin UI.
 */

import { writeFileSync } from 'fs'
import { join } from 'path'
import { logger } from '../logger.js'
import { readEnvFile } from '../env.js'
import { UPLOADS_DIR } from '../media.js'
import {
  loadKeys, getActiveKey, addKey as storeAddKey, deleteKey as storeDeleteKey,
  setActive as storeSetActive, updateKey, incrementUsed, redactKey,
  type StoredKey,
} from './key-store.js'

const EL_BASE = 'https://api.elevenlabs.io'

function clampFloat(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export function hasActiveKey(): boolean {
  return !!getActiveKey()
}

async function elFetch(path: string, init: RequestInit, apiKey: string): Promise<Response> {
  return fetch(`${EL_BASE}${path}`, {
    ...init,
    headers: {
      'xi-api-key': apiKey,
      'accept': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

async function fetchSubscription(apiKey: string): Promise<{ used: number; limit: number }> {
  const r = await elFetch('/v1/user/subscription', { method: 'GET' }, apiKey)
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`subscription ${r.status}: ${txt.slice(0, 200)}`)
  }
  const d = await r.json() as any
  return {
    used: Number(d.character_count || 0),
    limit: Number(d.character_limit || 0),
  }
}

/**
 * Synthesize a single chunk via ElevenLabs. Returns path to mp3 file.
 * Throws on any error — orchestrator decides whether to fall back to Edge.
 */
export async function synthElevenLabs(text: string, lang: 'uk' | 'ru' | 'en'): Promise<string> {
  const active = getActiveKey()
  if (!active) throw new Error('No active ElevenLabs key — add one in admin Audio tab and mark it active')

  const env = readEnvFile()
  const voiceId = env[`TTS_VOICE_${lang.toUpperCase()}`]
  if (!voiceId) throw new Error(`TTS_VOICE_${lang.toUpperCase()} not set — pick a voice in admin Audio tab`)
  const modelId = env['TTS_MODEL_ID'] ?? 'eleven_multilingual_v2'

  // Explicit voice_settings — must include `speed`, otherwise the model uses the
  // voice's per-voice default which is often >1.0 and makes speech sound rushed.
  const stability     = clampFloat(env['TTS_EL_STABILITY'],   0, 1, 0.6)
  const similarity    = clampFloat(env['TTS_EL_SIMILARITY'],  0, 1, 0.75)
  const speed         = clampFloat(env['TTS_EL_SPEED'],     0.7, 1.2, 1.0)
  const styleExag     = clampFloat(env['TTS_EL_STYLE'],       0, 1, 0)

  const r = await elFetch(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability,
        similarity_boost: similarity,
        style: styleExag,
        use_speaker_boost: true,
        speed,
      },
    }),
  }, active.key)

  if (!r.ok) {
    const errText = await r.text().catch(() => '')
    updateKey(active.id, { last_error: `${r.status}: ${errText.slice(0, 200)}` })
    throw new Error(`ElevenLabs ${r.status}: ${errText.slice(0, 200)}`)
  }

  const buf = Buffer.from(await r.arrayBuffer())
  const outPath = join(UPLOADS_DIR, `tts_${Date.now()}.mp3`)
  writeFileSync(outPath, buf)
  incrementUsed(active.id, text.length)
  logger.info({ chars: text.length, outPath, voiceId, keyId: active.id }, 'Speech synthesized (elevenlabs)')
  return outPath
}

// ---- Admin operations (called from bot-audio.ts) ----

export type KeyInfo = Omit<StoredKey, 'key'> & { key_preview: string }

export function adminListKeys(): KeyInfo[] {
  return loadKeys().map(redactKey)
}

export async function adminAddKey(key: string, label: string): Promise<KeyInfo> {
  const trimmed = key.trim()
  if (!trimmed) throw new Error('missing key')
  // Validate by calling subscription. This may succeed even for TTS-restricted keys,
  // but at least confirms the key exists.
  let sub: { used: number; limit: number }
  try { sub = await fetchSubscription(trimmed) } catch (err) {
    throw new Error(`invalid key: ${(err as Error).message}`)
  }
  const stored = storeAddKey(trimmed, label, sub)
  return redactKey(stored)
}

export function adminDeleteKey(id: string): void {
  storeDeleteKey(id)
}

export function adminSetActive(id: string): void {
  storeSetActive(id)
}

export interface VoiceInfo {
  voice_id: string
  name: string
  labels?: Record<string, string>
  preview_url?: string
}

export async function adminListVoices(): Promise<VoiceInfo[]> {
  const active = getActiveKey()
  if (!active) throw new Error('No active key — add one first')
  const r = await elFetch('/v1/voices', { method: 'GET' }, active.key)
  if (!r.ok) throw new Error(`voices ${r.status}`)
  const d = await r.json() as any
  return (d.voices || []).map((v: any) => ({
    voice_id: v.voice_id,
    name: v.name,
    labels: v.labels,
    preview_url: v.preview_url,
  }))
}

export async function adminReconcile(): Promise<KeyInfo[]> {
  const keys = loadKeys()
  for (const k of keys) {
    try {
      const sub = await fetchSubscription(k.key)
      k.used = sub.used
      k.limit = sub.limit
      k.last_reconciled = Date.now()
      k.last_error = ''
    } catch (err) {
      k.last_error = String((err as Error).message).slice(0, 200)
    }
  }
  // Re-save via setActive noop to persist
  const { saveKeys } = await import('./key-store.js')
  saveKeys(keys)
  return keys.map(redactKey)
}
