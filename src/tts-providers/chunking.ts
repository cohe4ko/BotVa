/**
 * Text chunking for TTS. Splits text on sentence boundaries so no chunk
 * exceeds maxPerChunk characters — without cutting sentences mid-flow.
 *
 * Abbreviation-safe: common abbreviations (т.д., п., etc.) don't trigger a split.
 */

export const MAX_EL_CHUNK = 4500     // ElevenLabs safe limit (API accepts ~5000)
export const MAX_EDGE_CHUNK = 8000   // edge-tts tolerates more but keep chunks manageable
export const MAX_GEMINI_CHUNK = 3000 // TTS model context is small (~8k tokens incl. audio out)
export const MAX_CHUNKS = 20         // hard cap to prevent 50-message spam
export const LONG_TEXT_THRESHOLD = 1500 // above this, bot asks user which provider to use

const ABBREV = new Set([
  'т.д', 'т.п', 'т.е', 'т.ч', 'і.т.д', 'і.т.п', 'і.т.ін',
  'п', 'пп', 'ст', 'стор', 'ч', 'ч.', 'гл', 'рис', 'табл', 'напр',
  'мр', 'mr', 'mrs', 'ms', 'dr', 'prof', 'proff', 'vs', 'etc', 'i.e', 'e.g',
])

/**
 * Split text into sentences. Honors ., !, ?, …, multiple together, trailing quotes/brackets.
 * Abbreviations do not cause a split.
 */
export function splitIntoSentences(text: string): string[] {
  const t = text.trim()
  if (!t) return []
  const sentences: string[] = []
  let current = ''
  const re = /[.!?…]+[\s\n\"')\]]*/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(t)) !== null) {
    const endIdx = m.index + m[0].length
    const candidate = t.slice(lastIdx, endIdx)
    // Check if previous word is an abbreviation (no letters after the final dot)
    const prevWord = t.slice(lastIdx, m.index).split(/[\s\n]/).pop() || ''
    const normalized = prevWord.toLowerCase().replace(/[^\p{L}.]/gu, '')
    if (ABBREV.has(normalized) || ABBREV.has(normalized.replace(/\.$/, ''))) {
      // not a real sentence end; continue accumulating
      continue
    }
    current += candidate
    sentences.push(current.trim())
    current = ''
    lastIdx = endIdx
  }
  const tail = (current + t.slice(lastIdx)).trim()
  if (tail) sentences.push(tail)
  return sentences
}

/**
 * Greedy pack sentences into chunks ≤ maxPerChunk chars. If a single sentence
 * exceeds the limit, fall back to splitting by commas, then whitespace, then hard slice.
 */
export function chunkText(text: string, maxPerChunk: number): string[] {
  const sentences = splitIntoSentences(text)
  const chunks: string[] = []
  let cur = ''
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = '' }

  for (const s of sentences) {
    if (s.length > maxPerChunk) {
      push()
      for (const sub of splitOversized(s, maxPerChunk)) chunks.push(sub)
      continue
    }
    if (!cur) { cur = s; continue }
    if (cur.length + 1 + s.length <= maxPerChunk) {
      cur += ' ' + s
    } else {
      push()
      cur = s
    }
  }
  push()
  return chunks
}

function splitOversized(s: string, max: number): string[] {
  // Try commas first
  const parts = s.split(/,\s*/)
  const out: string[] = []
  let cur = ''
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = '' }
  for (const p of parts) {
    if (p.length > max) {
      push()
      // Fall back to word split
      for (const w of hardSplit(p, max)) out.push(w)
      continue
    }
    if (!cur) { cur = p; continue }
    if (cur.length + 2 + p.length <= max) cur += ', ' + p
    else { push(); cur = p }
  }
  push()
  return out
}

function hardSplit(s: string, max: number): string[] {
  const words = s.split(/\s+/)
  const out: string[] = []
  let cur = ''
  for (const w of words) {
    if (w.length > max) {
      if (cur) { out.push(cur); cur = '' }
      for (let i = 0; i < w.length; i += max) out.push(w.slice(i, i + max))
      continue
    }
    if (!cur) { cur = w; continue }
    if (cur.length + 1 + w.length <= max) cur += ' ' + w
    else { out.push(cur); cur = w }
  }
  if (cur) out.push(cur)
  return out
}

/** Apply MAX_CHUNKS cap. Truncates tail with a marker. */
export function capChunks(chunks: string[]): string[] {
  if (chunks.length <= MAX_CHUNKS) return chunks
  const kept = chunks.slice(0, MAX_CHUNKS - 1)
  kept.push('[...]')
  return kept
}

export function isLongText(text: string): boolean {
  return text.length > LONG_TEXT_THRESHOLD
}
