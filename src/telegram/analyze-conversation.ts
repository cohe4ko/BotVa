/**
 * Tier 1 — turn one Telegram conversation into structured candidates.
 *
 * Runs in the receiving bot's process, not in the daemon. The daemon holds the
 * MTProto session and nothing else: it has no bot directory, no admin-set model
 * and no way into a bot's memory. The unattended-reply runner already
 * established this shape — read the shared log directly, reach the daemon over
 * the socket only for live actions.
 *
 * The parsing here is deliberately defensive. A background model returning
 * slightly-off JSON is normal, and one malformed field must cost one item, not
 * the whole conversation.
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { getBackgroundModel, parseModelConfig } from '../model.js'
import { ALLOWED_CHAT_ID } from '../config.js'
import { normalizeTopic } from '../listener-analyze.js'
import { jsonOutput, structuredOf, CONVERSATION_ANALYSIS_SCHEMA } from '../structured-output.js'

/** Categories Tier 1 may return. Order matters only for stable output. */
export const ITEM_KINDS = [
  'facts',
  'events',
  'commitments_mine',
  'commitments_theirs',
  'requests',
  'dates',
  'contacts',
] as const

export type ItemKind = typeof ITEM_KINDS[number]

export interface AnalysisItem {
  kind: ItemKind
  text: string
  who: string
  confidence: number
  when_due: string | null
  topic: string
  tags: string
  quote: string
  msg_ids: number[]
}

export interface ConversationChunk {
  chatTitle: string
  chatKind: string
  /** "canonical name — role" lines, so the model never has to write "he said". */
  participants: string[]
  /** Rendered transcript, one line per message. */
  transcript: string
  /** Every msg_id in the chunk — the fallback when the model cites none. */
  msgIds: number[]
  /** Tasks and reminders only make sense where the owner allowed them. */
  allowTasks: boolean
}

const PROMPT = `Ти аналізуєш фрагмент реального листування власника акаунта в Telegram.
Твоя робота — витягти те, що варто пам'ятати або зробити. Не переказ, не підсумок.

ЧАТ: {CHAT}
УЧАСНИКИ:
{PARTICIPANTS}

ПЕРЕПИСКА (найновіше внизу, у квадратних дужках — msg_id):
{TRANSCRIPT}

Поверни JSON:
{
  "facts":              [],
  "events":             [],
  "commitments_mine":   [],
  "commitments_theirs": [],
  "requests":           [],
  "dates":              [],
  "contacts":           []
}

Кожен елемент масиву:
{
  "text": "дистильоване формулювання, 1-2 речення",
  "who": "канонічне ім'я людини зі списку учасників, не займенник",
  "confidence": 0.0-1.0,
  "when_due": "ISO 8601 або null",
  "topic": "одне англійське слово (work, home, health, finance, family, tech, legal, travel, education)",
  "tags": "5-10 тегів через кому, ДВОМА мовами — синоніми і переклади",
  "quote": "дослівна цитата з переписки, на якій тримається цей пункт",
  "msg_ids": [123, 124]
}

🔒 ВХІДНІ Й ВИХІДНІ — РІЗНІ РЕЧІ. Це головне розрізнення:
- ВЛАСНИК написав «зроблю до п'ятниці» → commitments_mine. Він щось пообіцяв.
- ВЛАСНИКУ написали «зроби до п'ятниці» → requests. Його про щось попросили.
- ВЛАСНИКУ пообіцяли «привезу в середу» → commitments_theirs. Йому винні.
Не змішуй їх в один кошик «є ознаки доручення» — наслідки протилежні.

Категорії:
- facts — знання, які будуть корисні через три місяці
- events — що вже сталося
- dates — зустріч або дедлайн, які НЕ є чиєюсь обіцянкою чи проханням.
  Якщо дата вже стоїть у commitments або requests — не дублюй її окремим пунктом
  у dates. Один факт живе в одній категорії.
- contacts — нова людина, її роль, телефон, реквізити

🔒 quote і msg_ids ОБОВ'ЯЗКОВІ. Без них пункт неможливо ані перевірити, ані
зняти, коли джерело відредагують. Пункт без цитати не повертай узагалі.

Не витягуй:
- привітання, побутовий small talk, «ок», «дякую»
- наміри без рішення («може колись», «було б непогано»)
- те, що гуглиться за п'ять секунд: погода, курс, новини
- медичні дані третіх осіб, паролі, ключі, банківські реквізити інших людей,
  чужі особисті кризи — це не витягується в жодному режимі

confidence — наскільки ти впевнений, що це справді так і що це варто зберігати.
Здогад — це 0.3, а не 0.8. Краще менше пунктів із чесною оцінкою.

Мова тексту — мова переписки.
Порожні категорії лишай порожніми масивами. Тільки JSON, без markdown.`

const EMPTY: Record<ItemKind, unknown[]> = {
  facts: [], events: [], commitments_mine: [], commitments_theirs: [],
  requests: [], dates: [], contacts: [],
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** ISO-ish date or nothing. A model's "next Friday" is not a date. */
function asDue(v: unknown): string | null {
  const s = asString(v)
  if (!s || s === 'null') return null
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s : null
}

function asMsgIds(v: unknown, fallback: number[]): number[] {
  if (!Array.isArray(v)) return fallback
  const ids = v.map(Number).filter(n => Number.isFinite(n) && n > 0)
  return ids.length > 0 ? ids : fallback
}

/**
 * One raw item into our shape, or null if it is not usable.
 *
 * A missing quote is fatal by design: it is the audit trail, and an item
 * nobody can check is exactly the kind of noise that makes a memory useless.
 */
export function normalizeItem(kind: ItemKind, raw: unknown, chunkMsgIds: number[]): AnalysisItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const text = asString(r['text'])
  const quote = asString(r['quote'])
  if (!text || !quote) return null

  const confidence = Number(r['confidence'])
  return {
    kind,
    text,
    who: asString(r['who']),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    when_due: asDue(r['when_due']),
    topic: normalizeTopic(asString(r['topic'])),
    tags: asString(r['tags']),
    quote,
    msg_ids: asMsgIds(r['msg_ids'], chunkMsgIds),
  }
}

export function parseAnalysis(text: string, chunkMsgIds: number[]): AnalysisItem[] {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    return []
  }

  const out: AnalysisItem[] = []
  for (const kind of ITEM_KINDS) {
    const arr = parsed[kind]
    if (!Array.isArray(arr)) continue
    for (const raw of arr) {
      const item = normalizeItem(kind, raw, chunkMsgIds)
      if (item) out.push(item)
    }
  }
  return out
}

/** Categories that already carry their own date, making a `dates` twin redundant. */
const CARRIES_DATE: ItemKind[] = ['commitments_mine', 'commitments_theirs', 'requests']

/**
 * Drop `dates` items that only restate a commitment already extracted.
 *
 * The model reliably returns the same deadline twice — once as the promise and
 * once as the date — from the same quote. Both would become a fact and both
 * would raise a reminder, so the owner gets told twice about one thing. The
 * prompt asks for one; this makes sure of it, because a prompt is a request and
 * this is a guarantee.
 */
export function dedupeItems(items: AnalysisItem[]): AnalysisItem[] {
  const dated = items.filter(i => CARRIES_DATE.includes(i.kind))
  return items.filter(item => {
    if (item.kind !== 'dates') return true
    return !dated.some(other =>
      other.when_due === item.when_due &&
      other.msg_ids.some(id => item.msg_ids.includes(id)))
  })
}

export function buildPrompt(chunk: ConversationChunk): string {
  const participants = chunk.participants.length > 0
    ? chunk.participants.map(p => `- ${p}`).join('\n')
    : '- (невідомі)'
  return PROMPT
    .replace('{CHAT}', `${chunk.chatTitle} [${chunk.chatKind}]`)
    .replace('{PARTICIPANTS}', participants)
    .replace('{TRANSCRIPT}', chunk.transcript)
}

/** Categories that only make sense where the chat is allowed to produce tasks. */
const TASK_KINDS: ItemKind[] = ['commitments_mine', 'commitments_theirs', 'requests', 'dates']

export async function analyzeConversation(chunk: ConversationChunk): Promise<AnalysisItem[]> {
  if (!chunk.transcript.trim()) return []

  const { model } = parseModelConfig(getBackgroundModel(ALLOWED_CHAT_ID || '0'))
  let resultText = ''

  for await (const event of query({
    prompt: buildPrompt(chunk),
    // maxTurns 3: a schema miss is retried by the SDK as another turn
    options: { model, maxTurns: 3, outputFormat: jsonOutput(CONVERSATION_ANALYSIS_SCHEMA) },
  })) {
    const msg = event as SDKMessage
    // Structured output is the answer when present; the text blocks are the
    // fallback for a model that answered in prose anyway.
    const so = structuredOf(msg)
    if (so && typeof so === 'object') { resultText = JSON.stringify(so); break }
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') resultText += block.text
      }
    }
  }

  const items = dedupeItems(parseAnalysis(resultText, chunk.msgIds))
  // A facts-only chat may still surface a promise; it just must not become a
  // task there. Dropping it at the edge keeps the gate downstream simple.
  return chunk.allowTasks ? items : items.filter(i => !TASK_KINDS.includes(i.kind))
}

export const __testing = { EMPTY, PROMPT }
