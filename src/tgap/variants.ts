/**
 * Reply variants for the owner to choose from.
 *
 * One draft is often the wrong one — it repeats an earlier answer, or guesses
 * the owner's stance — and «edit» means typing the whole reply by hand. So the
 * drafting run offers two or three replies that differ in substance, and the
 * owner sends one with a button. The model writes them as:
 *
 *   ADVICE: optional one-line note for the owner
 *   === Label ===
 *   reply text
 *   === accept | Label ===      ← for a proposal: accept, counter or reject
 *   reply text
 *   DATA: {"json": "for expect.format json"}
 */

export type Decision = 'accepted' | 'rejected' | 'counter'

export interface Variant {
  label: string
  text: string
  /** Only for an answer to a proposal (§4.3). */
  decision?: Decision
  /** Structured answer when the request asked for JSON (`expect`). */
  data?: unknown
}

export interface ParsedDraft {
  variants: Variant[]
  /** A note for the owner, never sent: e.g. why not to answer at all. */
  advice?: string
}

export const MAX_VARIANTS = 3

const HEADER = /^\s*={3,}\s*(.+?)\s*={3,}\s*$/
const DECISIONS: Record<string, Decision> = {
  accept: 'accepted', accepted: 'accepted', yes: 'accepted',
  reject: 'rejected', rejected: 'rejected', no: 'rejected', decline: 'rejected',
  counter: 'counter',
}

function parseHeader(h: string): { label: string; decision?: Decision } {
  const bar = h.indexOf('|')
  if (bar > 0) {
    const d = DECISIONS[h.slice(0, bar).trim().toLowerCase()]
    if (d) return { label: h.slice(bar + 1).trim() || h.slice(0, bar).trim(), decision: d }
  }
  return { label: h.trim() }
}

/** Pull a trailing `DATA: {...}` line out of a variant, if it parses as JSON. */
function splitData(body: string): { text: string; data?: unknown } {
  const m = /\n?\s*DATA:\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/.exec(body)
  if (!m) return { text: body.trim() }
  try { return { text: body.slice(0, m.index).trim(), data: JSON.parse(m[1]) } } catch { return { text: body.trim() } }
}

export function parseVariants(raw: string): ParsedDraft {
  const text = raw.trim()
  if (!text) return { variants: [] }
  // The old single-answer contract, still honoured
  if (text.startsWith('NO-ANSWER:')) return { variants: [], advice: text.slice('NO-ANSWER:'.length).trim() }

  const lines = text.split('\n')
  let advice: string | undefined
  const variants: Variant[] = []
  let cur: { label: string; decision?: Decision; body: string[] } | null = null
  const preamble: string[] = []
  const flush = () => {
    if (!cur) return
    const { text: t, data } = splitData(cur.body.join('\n'))
    if (t) variants.push({ label: cur.label.slice(0, 40), text: t, ...(cur.decision ? { decision: cur.decision } : {}), ...(data !== undefined ? { data } : {}) })
  }
  for (const line of lines) {
    const h = HEADER.exec(line)
    if (h) { flush(); cur = { ...parseHeader(h[1]), body: [] }; continue }
    if (cur) cur.body.push(line)
    else preamble.push(line)
  }
  flush()

  const pre = preamble.join('\n').trim()
  const adv = /^ADVICE:\s*(.+)$/im.exec(pre)
  if (adv) advice = adv[1].trim()
  if (variants.length === 0) {
    // No headers: the whole text is one reply
    const rest = pre.replace(/^ADVICE:.*$/im, '').trim()
    if (rest) variants.push({ label: 'Відповідь', ...splitData(rest) })
  }
  return { variants: variants.slice(0, MAX_VARIANTS), ...(advice ? { advice } : {}) }
}

export function decisionWords(d: Decision | string | null | undefined): string {
  switch (d) {
    case 'accepted': return 'погодитись'
    case 'rejected': return 'відмовитись'
    case 'counter': return 'зустрічна пропозиція'
    default: return ''
  }
}
