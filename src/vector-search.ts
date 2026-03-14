/**
 * Hybrid search: FTS5 + vector cosine similarity.
 * Falls back to FTS-only when embedding service is unavailable.
 */

import { searchFacts, type Fact } from './db.js'
import { embed, cosineSim, isReady } from './embeddings.js'
import { getFactsWithEmbeddings } from './db.js'
import { logger } from './logger.js'

// Query embedding cache (TTL 5 min, max 100 entries)
const queryCache = new Map<string, { vec: Float32Array; ts: number }>()
const CACHE_TTL = 5 * 60 * 1000
const CACHE_MAX = 100

function getCachedQuery(key: string): Float32Array | null {
  const entry = queryCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) {
    queryCache.delete(key)
    return null
  }
  return entry.vec
}

function setCachedQuery(key: string, vec: Float32Array): void {
  if (queryCache.size >= CACHE_MAX) {
    // Evict oldest
    let oldestKey: string | null = null
    let oldestTs = Infinity
    for (const [k, v] of queryCache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k }
    }
    if (oldestKey) queryCache.delete(oldestKey)
  }
  queryCache.set(key, { vec, ts: Date.now() })
}

const VECTOR_THRESHOLD = 0.4

export async function searchFactsHybrid(
  chatId: string, query: string, limit = 10, topic?: string
): Promise<Fact[]> {
  // 1. FTS5 search (always runs)
  const ftsResults = searchFacts(chatId, query, limit * 2, topic)

  // 2. Vector search (if available)
  let vectorResults: Fact[] = []

  const embeddingReady = await isReady()
  if (embeddingReady) {
    try {
      // Get query embedding (with cache)
      const cacheKey = `${chatId}:${topic ?? ''}:${query}`
      let queryVec = getCachedQuery(cacheKey)
      if (!queryVec) {
        queryVec = await embed(query, 'query')
        if (queryVec) setCachedQuery(cacheKey, queryVec)
      }

      if (queryVec) {
        // Load facts with embeddings from DB
        const factsWithEmb = getFactsWithEmbeddings(chatId, topic)

        // Compute cosine similarity
        const scored: { fact: Fact; score: number }[] = []
        for (const f of factsWithEmb) {
          if (!f.embedding) continue
          const vec = new Float32Array(f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength / 4)
          const score = cosineSim(queryVec, vec)
          if (score > VECTOR_THRESHOLD) {
            scored.push({ fact: f, score })
          }
        }

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score)
        vectorResults = scored.slice(0, limit * 2).map(s => s.fact)
      }
    } catch (err) {
      logger.warn({ err }, 'Vector search failed, using FTS only')
    }
  }

  // 3. Merge + deduplicate
  const seen = new Set<number>()
  const merged: Fact[] = []

  // Interleave: FTS first (they matched keywords), then vector results
  for (const f of ftsResults) {
    if (!seen.has(f.id)) {
      seen.add(f.id)
      merged.push(f)
    }
  }
  for (const f of vectorResults) {
    if (!seen.has(f.id)) {
      seen.add(f.id)
      merged.push(f)
    }
  }

  return merged.slice(0, limit)
}
