/**
 * Socket client for embedding service.
 * No ML dependencies — all inference happens in the embedding server process.
 */

import { connect } from 'net'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

const SOCK_PATH = process.env['EMBEDDING_SOCK_PATH'] ?? resolve(PROJECT_ROOT, 'store', 'embedding.sock')
const EMBEDDINGS_ENABLED = (process.env['EMBEDDINGS_ENABLED'] ?? 'true') === 'true'

// Cache socket existence check (30 sec TTL)
let socketExistsCache: boolean | null = null
let socketExistsCacheTs = 0
const SOCKET_CACHE_TTL = 30_000

function socketExists(): boolean {
  const now = Date.now()
  if (socketExistsCache !== null && now - socketExistsCacheTs < SOCKET_CACHE_TTL) {
    return socketExistsCache
  }
  socketExistsCache = existsSync(SOCK_PATH)
  socketExistsCacheTs = now
  return socketExistsCache
}

function invalidateSocketCache(): void {
  socketExistsCache = null
}

interface EmbedResponse {
  embeddings?: number[][]
  error?: string
}

interface HealthResponse {
  ready?: boolean
  model?: string
  uptime?: number
  requestCount?: number
  textsEmbedded?: number
  error?: string
}

function sendRequest<T>(request: object, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCK_PATH)
    let data = ''
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('Embedding service timeout'))
    }, timeoutMs)

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n')
    })

    sock.on('data', (chunk) => {
      data += chunk.toString()
      const nlIdx = data.indexOf('\n')
      if (nlIdx !== -1) {
        clearTimeout(timer)
        try {
          resolve(JSON.parse(data.slice(0, nlIdx)) as T)
        } catch (e) {
          reject(new Error('Invalid response from embedding service'))
        }
        sock.end()
      }
    })

    sock.on('error', (err) => {
      clearTimeout(timer)
      invalidateSocketCache()
      reject(err)
    })
  })
}

/**
 * Embed a single text. Returns Float32Array or null if service unavailable.
 */
export async function embed(text: string, type: 'query' | 'passage'): Promise<Float32Array | null> {
  if (!EMBEDDINGS_ENABLED || !socketExists()) return null
  try {
    const resp = await sendRequest<EmbedResponse>(
      { action: 'embed', texts: [text], type },
      5000
    )
    if (resp.error || !resp.embeddings?.[0]) return null
    return new Float32Array(resp.embeddings[0])
  } catch (err) {
    logger.debug({ err }, 'embed() failed')
    return null
  }
}

/**
 * Embed multiple texts. Returns array of Float32Array | null.
 */
export async function embedBatch(texts: string[], type: 'query' | 'passage'): Promise<(Float32Array | null)[]> {
  if (!EMBEDDINGS_ENABLED || !socketExists() || texts.length === 0) {
    return texts.map(() => null)
  }
  try {
    const resp = await sendRequest<EmbedResponse>(
      { action: 'embed', texts, type },
      30_000
    )
    if (resp.error || !resp.embeddings) return texts.map(() => null)
    return resp.embeddings.map(e => e ? new Float32Array(e) : null)
  } catch (err) {
    logger.debug({ err }, 'embedBatch() failed')
    return texts.map(() => null)
  }
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Check if embedding service is ready.
 */
export async function isReady(): Promise<boolean> {
  if (!EMBEDDINGS_ENABLED || !socketExists()) return false
  try {
    const resp = await sendRequest<HealthResponse>({ action: 'health' }, 3000)
    return resp.ready === true
  } catch {
    return false
  }
}

/**
 * Get health info from embedding service.
 */
export async function getHealth(): Promise<HealthResponse | null> {
  if (!socketExists()) return null
  try {
    return await sendRequest<HealthResponse>({ action: 'health' }, 3000)
  } catch {
    return null
  }
}

/**
 * Reset request counters.
 */
export async function resetStats(): Promise<boolean> {
  if (!socketExists()) return false
  try {
    const resp = await sendRequest<{ ok?: boolean }>({ action: 'reset-stats' }, 3000)
    return resp.ok === true
  } catch {
    return false
  }
}
