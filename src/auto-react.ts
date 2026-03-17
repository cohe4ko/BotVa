/**
 * Auto-react to user messages using embedding similarity.
 * Zero tokens — runs entirely on local embedding service.
 *
 * Each category has multiple emoji alternatives — picked randomly
 * for variety. Categories are semantic clusters, not fixed mappings.
 */

import { embed, cosineSim } from './embeddings.js'
import { logger } from './logger.js'

// Reaction categories: emoji alternatives + reference phrases
// First emoji in array is most common (higher weight), rest add variety
const REACTION_REFS: { emojis: string[]; phrases: string[] }[] = [
  // Gratitude
  { emojis: ['❤️', '🙏', '🤗', '❤️‍🔥', '💕'],
    phrases: ['дякую', 'спасибі', 'thanks', 'дякс', 'thx', 'thank you', 'мерсі', 'дуже дякую', 'ти найкращий', 'ти супер'] },
  // Laughter
  { emojis: ['😂', '🤣', '😁', '💀'],
    phrases: ['ахаха', 'хахаха', 'лол', 'lol', 'haha', 'ржу', 'смішно', 'жиза', 'ору', 'dying', 'rofl'] },
  // Excitement / cool
  { emojis: ['🔥', '⚡️', '🤩', '💯', '🆒'],
    phrases: ['круто', 'клас', 'вау', 'wow', 'cool', 'nice', 'awesome', 'sick', 'зашибісь', 'файно', 'шикарно', 'бомба'] },
  // Acknowledgment / ok
  { emojis: ['👌', '👍', '🫡'],
    phrases: ['ок', 'окей', 'зрозуміло', 'ясно', 'добре', 'got it', 'okay', 'ладно', 'прийнято', 'зрозумів'] },
  // Command / let's go
  { emojis: ['🫡', '⚡️', '🏆'],
    phrases: ['зроби', 'давай', 'запускай', 'починай', 'do it', 'go ahead', "let's go", 'вперед', 'поїхали', 'реалізуй', 'роби'] },
  // Thinking / curious
  { emojis: ['🤔', '🤨', '🧐'],
    phrases: ['хм', 'цікаво', 'hmm', 'interesting', 'а що якщо', 'не впевнений', 'дивно', 'не зрозуміло'] },
  // Confirmation / works
  { emojis: ['👍', '✅', '👏'],
    phrases: ['все ок', 'працює', 'супер', 'норм', 'нормально', 'все добре', 'все працює', 'виглядає добре'] },
  // Celebration / achievement
  { emojis: ['🎉', '🏆', '🍾', '🥳'],
    phrases: ['вийшло', 'зробив', 'готово', 'нарешті', 'перемога', 'вдалось', 'accomplished', 'done', 'finally', 'achieved'] },
  // Love / affection
  { emojis: ['🥰', '😍', '💘', '❤️'],
    phrases: ['люблю', 'обожнюю', 'love it', 'beautiful', 'чудово', 'прекрасно', 'gorgeous', 'милота', 'adorable'] },
  // Surprise / mind blown
  { emojis: ['🤯', '😱', '😮', '👀'],
    phrases: ['нічого собі', 'не може бути', 'серйозно', 'ого', 'omg', 'what', 'no way', 'mind blown', 'неочікувано', 'шок'] },
  // Sadness / empathy
  { emojis: ['😢', '💔', '🫂'],
    phrases: ['сумно', 'шкода', 'sad', 'unfortunately', 'на жаль', 'поганенько', 'не вдалося', 'розчарування', 'прикро'] },
  // Greeting
  { emojis: ['👋', '🤝', '😊'],
    phrases: ['привіт', 'hello', 'hi', 'вітаю', 'доброго ранку', 'добрий день', 'добрий вечір', 'hey', 'morning'] },
]

const SIMILARITY_THRESHOLD = 0.72
const MAX_MESSAGE_LENGTH = 200 // skip long messages (likely tasks, not reactions)

// Pre-computed reference embeddings (cached after first use)
let refEmbeddings: { emojis: string[]; embeddings: Float32Array[] }[] | null = null
let initPromise: Promise<void> | null = null

/**
 * Initialize reference embeddings. Called once, cached forever.
 */
async function initRefs(): Promise<void> {
  if (refEmbeddings) return
  if (initPromise) { await initPromise; return }

  initPromise = (async () => {
    const results: { emojis: string[]; embeddings: Float32Array[] }[] = []

    for (const ref of REACTION_REFS) {
      const embeddings: Float32Array[] = []
      for (const phrase of ref.phrases) {
        const vec = await embed(phrase, 'passage')
        if (vec) embeddings.push(vec)
      }
      if (embeddings.length > 0) {
        results.push({ emojis: ref.emojis, embeddings })
      }
    }

    refEmbeddings = results
    logger.info({ categories: results.length, totalPhrases: results.reduce((s, r) => s + r.embeddings.length, 0) }, 'Auto-react embeddings initialized')
  })()

  await initPromise
}

/**
 * Pick a random emoji from alternatives with weighted distribution.
 * First emoji has ~50% chance, rest split the other 50%.
 */
function pickEmoji(emojis: string[]): string {
  if (emojis.length === 1) return emojis[0]

  // First emoji gets weight 2, rest get weight 1
  const totalWeight = emojis.length + 1 // first has 2, rest have 1 each
  const roll = Math.random() * totalWeight

  if (roll < 2) return emojis[0] // ~50% for primary
  const idx = Math.floor(roll - 2) + 1
  return emojis[Math.min(idx, emojis.length - 1)]
}

/**
 * Classify a message and return the best matching emoji, or null if no match.
 * Picks from category alternatives randomly for variety.
 */
export async function classifyReaction(message: string): Promise<string | null> {
  // Skip too short or too long messages
  if (message.length < 1 || message.length > MAX_MESSAGE_LENGTH) return null

  // Skip messages that look like commands
  if (message.startsWith('/')) return null

  await initRefs()
  if (!refEmbeddings || refEmbeddings.length === 0) return null

  const msgVec = await embed(message, 'query')
  if (!msgVec) return null

  let bestCategory: string[] | null = null
  let bestScore = 0

  for (const ref of refEmbeddings) {
    for (const refVec of ref.embeddings) {
      const score = cosineSim(msgVec, refVec)
      if (score > bestScore) {
        bestScore = score
        bestCategory = ref.emojis
      }
    }
  }

  if (bestScore >= SIMILARITY_THRESHOLD && bestCategory) {
    const emoji = pickEmoji(bestCategory)
    logger.debug({ emoji, score: bestScore.toFixed(3), message: message.slice(0, 50), alternatives: bestCategory.length }, 'Auto-react match')
    return emoji
  }

  return null
}
