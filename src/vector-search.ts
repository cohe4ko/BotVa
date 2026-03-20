/**
 * Hybrid search: FTS5 + vector cosine similarity + multi-hop spreading activation.
 * Falls back to FTS-only when embedding service is unavailable.
 */

import { searchFacts, type Fact, getFactsWithEmbeddings, getLinkedFacts } from './db.js'
import { embed, cosineSim, isReady } from './embeddings.js'
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
const LINK_THRESHOLD = 0.5
const MIN_COMBINED_SCORE = 0.25
const DIVERSITY_THRESHOLD = 0.85 // cosine sim between two results to consider duplicate
const EPISODIC_DECAY_DAYS = 180

interface ScoredFact {
  fact: Fact
  vectorScore: number  // cosine similarity (0-1)
  hop: 1 | 2 | 3       // 1=direct, 2=spreading activation, 3=graph link
}

export interface HybridSearchResult {
  facts: Fact[]
  totalCandidates: number  // how many facts found before filtering
  hasMore: boolean         // there are more relevant facts beyond limit
}

/**
 * Compute combined ranking score for a fact.
 * Weights: vectorSimilarity 40%, importance 30%, usefulness 20%, hop bonus 10%
 */
function combinedScore(sf: ScoredFact): number {
  const imp = sf.fact.importance ?? 0.5
  const useful = Math.min(sf.fact.usefulness ?? 0, 2.0) / 2.0
  const hopBonus = sf.hop === 1 ? 1.0 : sf.hop === 2 ? 0.5 : 0.3
  let score = (sf.vectorScore * 0.4) + (imp * 0.3) + (useful * 0.2) + (hopBonus * 0.1)

  // Recency decay for episodic facts older than 180 days
  if (sf.fact.sector === 'episodic') {
    const ageDays = (Date.now() / 1000 - sf.fact.created_at) / 86400
    if (ageDays > EPISODIC_DECAY_DAYS) score *= 0.7
  }

  return score
}

/**
 * Remove near-duplicate results (cosine similarity > threshold between results).
 * Keeps the one with higher combined score.
 */
function deduplicateByContent(scored: ScoredFact[], factsWithEmb: Map<number, Float32Array>): ScoredFact[] {
  const result: ScoredFact[] = []

  for (const sf of scored) {
    const sfVec = factsWithEmb.get(sf.fact.id)
    let isDuplicate = false

    if (sfVec) {
      for (const existing of result) {
        const existingVec = factsWithEmb.get(existing.fact.id)
        if (existingVec) {
          const sim = cosineSim(sfVec, existingVec)
          if (sim > DIVERSITY_THRESHOLD) {
            isDuplicate = true
            break
          }
        }
      }
    }

    if (!isDuplicate) result.push(sf)
  }

  return result
}

export async function searchFactsHybrid(
  chatId: string, query: string, limit = 10, topic?: string,
  opts?: { hops?: 1 | 2 }
): Promise<HybridSearchResult> {
  const hops = opts?.hops ?? 2

  // 1. FTS5 search (always runs)
  const ftsResults = searchFacts(chatId, query, limit * 2, topic)

  // 2. Vector search hop 1 (if available)
  const allScored: ScoredFact[] = []
  const seen = new Set<number>()
  const embeddingMap = new Map<number, Float32Array>() // for diversity check

  // Add FTS results with default vector score
  for (const f of ftsResults) {
    if (!seen.has(f.id)) {
      seen.add(f.id)
      allScored.push({ fact: f, vectorScore: 0.5, hop: 1 })
    }
  }

  const embeddingReady = await isReady()
  let factsWithEmb: (Fact & { embedding: Buffer | null })[] = []

  if (embeddingReady) {
    try {
      const cacheKey = `${chatId}:${topic ?? ''}:${query}`
      let queryVec = getCachedQuery(cacheKey)
      if (!queryVec) {
        queryVec = await embed(query, 'query')
        if (queryVec) setCachedQuery(cacheKey, queryVec)
      }

      if (queryVec) {
        factsWithEmb = getFactsWithEmbeddings(chatId, topic)

        // Build embedding map for diversity check
        for (const f of factsWithEmb) {
          if (f.embedding) {
            embeddingMap.set(f.id, new Float32Array(f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength / 4))
          }
        }

        // Hop 1: direct vector search
        const hop1Scored: { fact: Fact; score: number }[] = []
        for (const f of factsWithEmb) {
          const vec = embeddingMap.get(f.id)
          if (!vec) continue
          const score = cosineSim(queryVec, vec)
          if (score > VECTOR_THRESHOLD) {
            hop1Scored.push({ fact: f, score })
          }
        }

        hop1Scored.sort((a, b) => b.score - a.score)

        // Dynamic filtering
        if (hop1Scored.length >= 2) {
          const topN = hop1Scored.slice(0, Math.min(10, hop1Scored.length))
          const spread = topN[0].score - topN[topN.length - 1].score

          if (spread >= 0.05) {
            const cutoff = hop1Scored[0].score * 0.7
            for (const s of hop1Scored) {
              if (s.score <= cutoff) break
              if (!seen.has(s.fact.id)) {
                seen.add(s.fact.id)
                allScored.push({ fact: s.fact, vectorScore: s.score, hop: 1 })
              } else {
                const existing = allScored.find(sf => sf.fact.id === s.fact.id)
                if (existing && s.score > existing.vectorScore) existing.vectorScore = s.score
              }
            }
          }
        } else {
          for (const s of hop1Scored.slice(0, 5)) {
            if (!seen.has(s.fact.id)) {
              seen.add(s.fact.id)
              allScored.push({ fact: s.fact, vectorScore: s.score, hop: 1 })
            } else {
              const existing = allScored.find(sf => sf.fact.id === s.fact.id)
              if (existing && s.score > existing.vectorScore) existing.vectorScore = s.score
            }
          }
        }

        // Hop 2: spreading activation
        if (hops >= 2 && allScored.length > 0) {
          const hop1Top = allScored
            .filter(sf => sf.hop === 1)
            .sort((a, b) => combinedScore(b) - combinedScore(a))
            .slice(0, 3)

          for (const sf of hop1Top) {
            const factVec = await embed(sf.fact.content, 'query')
            if (!factVec) continue

            for (const f of factsWithEmb) {
              if (!f.embedding || seen.has(f.id)) continue
              const vec = embeddingMap.get(f.id)!
              const score = cosineSim(factVec, vec)
              if (score > LINK_THRESHOLD) {
                seen.add(f.id)
                allScored.push({ fact: f, vectorScore: score * 0.8, hop: 2 })
              }
            }

            // Graph expansion: follow explicit links
            try {
              const linked = getLinkedFacts(sf.fact.id, chatId, 3)
              for (const lf of linked) {
                if (!seen.has(lf.id)) {
                  seen.add(lf.id)
                  allScored.push({ fact: lf, vectorScore: lf.linkStrength * 0.7, hop: 3 })
                }
              }
            } catch { /* links table may not exist yet */ }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Vector search failed, using FTS only')
    }
  }

  // 3. Filter, deduplicate, rank
  const totalCandidates = allScored.length

  // Score threshold — remove low-quality results
  let filtered = allScored.filter(sf => combinedScore(sf) >= MIN_COMBINED_SCORE)

  // Sort by combined score
  filtered.sort((a, b) => combinedScore(b) - combinedScore(a))

  // Diversity filtering — remove near-duplicates
  if (embeddingMap.size > 0) {
    filtered = deduplicateByContent(filtered, embeddingMap)
  }

  // Determine hasMore before slicing
  const hasMore = filtered.length > limit &&
    filtered.slice(limit).filter(sf => combinedScore(sf) > 0.4).length >= 2

  return {
    facts: filtered.slice(0, limit).map(sf => sf.fact),
    totalCandidates,
    hasMore,
  }
}
