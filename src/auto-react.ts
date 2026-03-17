/**
 * Auto-react to user messages using embedding similarity.
 * Zero tokens — runs entirely on local embedding service.
 */

import { embed, cosineSim } from './embeddings.js'
import { logger } from './logger.js'

// Reaction categories with reference phrases
const REACTION_REFS: { emoji: string; phrases: string[] }[] = [
  { emoji: '❤️', phrases: ['дякую', 'спасибі', 'thanks', 'дякс', 'thx', 'thank you', 'мерсі', 'дуже дякую', 'ти найкращий', 'ти супер'] },
  { emoji: '😂', phrases: ['ахаха', 'хахаха', 'лол', 'lol', 'haha', 'ржу', 'смішно', 'жиза', 'ору', 'dying', 'rofl'] },
  { emoji: '🔥', phrases: ['круто', 'клас', 'вау', 'wow', 'cool', 'nice', 'awesome', 'sick', 'зашибісь', 'файно', 'шикарно', 'бомба'] },
  { emoji: '👌', phrases: ['ок', 'окей', 'зрозуміло', 'ясно', 'добре', 'got it', 'okay', 'ладно', 'прийнято', 'зрозумів'] },
  { emoji: '🫡', phrases: ['зроби', 'давай', 'запускай', 'починай', 'do it', 'go ahead', 'let\'s go', 'вперед', 'поїхали', 'реалізуй', 'роби'] },
  { emoji: '🤔', phrases: ['хм', 'цікаво', 'hmm', 'interesting', 'а що якщо', 'не впевнений', 'дивно', 'не зрозуміло'] },
  { emoji: '👍', phrases: ['все ок', 'працює', 'супер', 'норм', 'нормально', 'все добре', 'все працює', 'виглядає добре'] },
]

const SIMILARITY_THRESHOLD = 0.72
const MIN_MESSAGE_LENGTH = 1
const MAX_MESSAGE_LENGTH = 200 // skip long messages (likely tasks, not reactions)

// Pre-computed reference embeddings (cached after first use)
let refEmbeddings: { emoji: string; embeddings: Float32Array[] }[] | null = null
let initPromise: Promise<void> | null = null

/**
 * Initialize reference embeddings. Called once, cached forever.
 */
async function initRefs(): Promise<void> {
  if (refEmbeddings) return
  if (initPromise) { await initPromise; return }

  initPromise = (async () => {
    const results: { emoji: string; embeddings: Float32Array[] }[] = []

    for (const ref of REACTION_REFS) {
      const embeddings: Float32Array[] = []
      for (const phrase of ref.phrases) {
        const vec = await embed(phrase, 'passage')
        if (vec) embeddings.push(vec)
      }
      if (embeddings.length > 0) {
        results.push({ emoji: ref.emoji, embeddings })
      }
    }

    refEmbeddings = results
    logger.info({ categories: results.length, totalPhrases: results.reduce((s, r) => s + r.embeddings.length, 0) }, 'Auto-react embeddings initialized')
  })()

  await initPromise
}

/**
 * Classify a message and return the best matching emoji, or null if no match.
 */
export async function classifyReaction(message: string): Promise<string | null> {
  // Skip too short or too long messages
  if (message.length < MIN_MESSAGE_LENGTH || message.length > MAX_MESSAGE_LENGTH) return null

  // Skip messages that look like commands or tasks
  if (message.startsWith('/')) return null

  await initRefs()
  if (!refEmbeddings || refEmbeddings.length === 0) return null

  const msgVec = await embed(message, 'query')
  if (!msgVec) return null

  let bestEmoji: string | null = null
  let bestScore = 0

  for (const ref of refEmbeddings) {
    for (const refVec of ref.embeddings) {
      const score = cosineSim(msgVec, refVec)
      if (score > bestScore) {
        bestScore = score
        bestEmoji = ref.emoji
      }
    }
  }

  if (bestScore >= SIMILARITY_THRESHOLD) {
    logger.debug({ emoji: bestEmoji, score: bestScore.toFixed(3), message: message.slice(0, 50) }, 'Auto-react match')
    return bestEmoji
  }

  return null
}
