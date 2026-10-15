/**
 * Tier 1 runner — conversations in, candidates out.
 *
 * Lives in the receiving bot's process for the same reasons the unattended-reply
 * runner does: the model, the API key, the bot's memory and its reminders are
 * all here, and none of them are in the daemon. It reads the shared observer log
 * directly and never opens an MTProto connection of its own.
 *
 * Nothing here runs unless a chat names this bot in `target_bot`. Logging a chat
 * and writing its contents into a bot's long-term memory are separate decisions,
 * and the second one is always explicit.
 */

import { BOT_NAME } from './env.js'
import { ALLOWED_CHAT_ID } from './config.js'
import { logger } from './logger.js'
import { insertReminder, getFactsWithEmbeddings, boostFactUsefulness } from './db.js'
import { insertFactForBot } from './admin/db-multi.js'
import { embed, cosineSim } from './embeddings.js'
import {
  listAnalysisTargets, getUnanalysedMessages, markAnalysed, recordExtraction,
  listPeople, personName, noteTier1Call, getBudget,
  type AnalysisTarget, type TgMessage, type TgPerson,
} from './telegram/db.js'
import { shouldFlush, secondsUntilDue } from './telegram/conversation-buffer.js'
import { analyzeConversation, type AnalysisItem, type ConversationChunk } from './telegram/analyze-conversation.js'
import { gate, sectorFor, isDuplicate } from './telegram/gate.js'

/**
 * Daily ceiling on Tier 1 runs.
 *
 * Not a cost estimate — a hard stop. Logging continues when it is reached;
 * only the analysis pauses, and it resumes at midnight.
 */
const DAILY_CALL_BUDGET = 200

/** Hourly ceiling, so one busy evening cannot spend the whole day's budget. */
const HOURLY_CALL_BUDGET = 40

/** Messages per chunk. Above this the conversation is analysed in pieces. */
const CHUNK_MESSAGES = 40

/** How much of one message goes into the prompt. */
const LINE_CHARS = 600

/** Bounds on the sleep between passes. */
const MIN_SLEEP_MS = 30_000
const MAX_SLEEP_MS = 5 * 60_000

let timer: ReturnType<typeof setTimeout> | null = null
/** Chats being analysed right now — a slow model must not be entered twice. */
const inFlight = new Set<string>()
/** Timestamps of recent Tier 1 calls, for the hourly ceiling. */
const recentCalls: number[] = []

function hourlyCalls(nowMs: number): number {
  while (recentCalls.length > 0 && nowMs - recentCalls[0]! > 3_600_000) recentCalls.shift()
  return recentCalls.length
}

const timeFmt = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
})

/** Deleted rows keep a tombstone with no text; they carry nothing to analyse. */
function readable(rows: TgMessage[]): TgMessage[] {
  return rows.filter(m => !m.deleted_ts && (m.text.trim() || m.media_type))
}

/**
 * The transcript Tier 1 reads.
 *
 * Every line carries its msg_id, because the model is required to cite them and
 * cannot invent what it was never shown. The owner is labelled explicitly: the
 * whole point of the prompt is that his lines and theirs mean opposite things.
 */
export function renderTranscript(rows: TgMessage[], people: Map<string, TgPerson>, chatTitle: string): string {
  return readable(rows).map(m => {
    const when = timeFmt.format(new Date(m.ts * 1000))
    let who: string
    if (m.direction === 'out') {
      who = 'ВЛАСНИК'
    } else {
      const known = m.sender_id ? people.get(m.sender_id) : undefined
      who = known ? personName(known) : (m.sender_name || chatTitle)
    }
    let body = m.text.trim() || `[${m.media_type ?? 'вкладення'}]`
    if (body.length > LINE_CHARS) body = `${body.slice(0, LINE_CHARS).trimEnd()}…`
    const quoted = m.reply_to ? ` (у відповідь на #${m.reply_to})` : ''
    return `[${when} #${m.msg_id}] ${who}${quoted}: ${body}`
  }).join('\n')
}

/**
 * Who the model is allowed to name.
 *
 * "Приїду в четвер" from a spouse and from a contractor are different facts.
 * Without this list the model writes "he said", and the fact becomes rubbish.
 */
export function participantLines(people: TgPerson[]): string[] {
  return people.map(p => {
    const bits = [personName(p)]
    if (p.username) bits.push(`@${p.username}`)
    if (p.role) bits.push(`— ${p.role}`)
    if (p.note) bits.push(`(${p.note})`)
    return bits.join(' ')
  })
}

function buildChunk(target: AnalysisTarget, rows: TgMessage[]): ConversationChunk {
  const people = listPeople({ chatId: target.chat_id, limit: 60 })
  const byId = new Map(people.map(p => [p.peer_id, p]))
  return {
    chatTitle: target.title,
    chatKind: target.kind,
    participants: participantLines(people),
    transcript: renderTranscript(rows, byId, target.title),
    msgIds: readable(rows).map(m => m.msg_id),
    // Tasks and reminders only where the owner opened the chat fully.
    allowTasks: target.mode === 'full',
  }
}

/**
 * Is this candidate something the memory already holds?
 *
 * One agreement gets mentioned five times in a conversation. A duplicate is not
 * dropped silently — the existing fact is boosted, so repetition strengthens
 * what is known instead of multiplying it.
 */
async function findDuplicate(text: string, topic: string): Promise<number | null> {
  let vec: Float32Array | null = null
  try {
    vec = await embed(text, 'passage')
  } catch { return null }
  if (!vec) return null

  const existing = getFactsWithEmbeddings(ALLOWED_CHAT_ID || '0', topic)
  for (const f of existing) {
    if (!f.embedding) continue
    const other = new Float32Array(
      f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength / 4,
    )
    if (other.length !== vec.length) continue
    if (isDuplicate(cosineSim(vec, other))) return f.id
  }
  return null
}

function dueDateSeconds(when: string): number | null {
  const t = Date.parse(when)
  if (!Number.isFinite(t)) return null
  const secs = Math.floor(t / 1000)
  // A deadline already past cannot be scheduled; the fact still gets written.
  return secs > Math.floor(Date.now() / 1000) ? secs : null
}

/** Apply the gate to one item and persist whatever it decided. */
async function applyItem(target: AnalysisTarget, item: AnalysisItem): Promise<string> {
  const decision = gate(item)
  const base = {
    chat_id: target.chat_id,
    kind: item.kind,
    target_bot: BOT_NAME,
    text: item.text,
    who: item.who,
    topic: item.topic,
    tags: item.tags,
    quote: item.quote,
    msg_ids: item.msg_ids,
    when_due: item.when_due,
    confidence: item.confidence,
  }

  if (decision.action === 'drop') {
    recordExtraction({ ...base, status: 'dropped' })
    return 'drop'
  }

  if (decision.action === 'queue') {
    recordExtraction({ ...base, status: 'pending' })
    return 'queue'
  }

  const duplicateOf = await findDuplicate(item.text, item.topic)
  if (duplicateOf !== null) {
    boostFactUsefulness(duplicateOf, ALLOWED_CHAT_ID || '0')
    recordExtraction({ ...base, status: 'duplicate', fact_id: duplicateOf })
    return 'duplicate'
  }

  const factId = insertFactForBot(
    BOT_NAME,
    ALLOWED_CHAT_ID || '0',
    item.text,
    item.topic,
    sectorFor(item.kind),
    item.tags,
    `telegram:${target.chat_id}`,
    item.confidence,
  )

  let reminderId: number | null = null
  if (decision.reminder && item.when_due) {
    const at = dueDateSeconds(item.when_due)
    if (at !== null) {
      reminderId = insertReminder(ALLOWED_CHAT_ID || '0', item.text, at)
    }
  }

  recordExtraction({ ...base, status: 'saved', fact_id: factId, reminder_id: reminderId })
  return 'save'
}

/** Analyse one chat's backlog. Returns how many items were kept. */
async function analyzeChat(target: AnalysisTarget): Promise<void> {
  const rows = getUnanalysedMessages(target.chat_id, target.analyzed_msg_id, CHUNK_MESSAGES)
  const usable = readable(rows)
  const highest = rows.length > 0 ? Math.max(...rows.map(m => m.msg_id)) : target.analyzed_msg_id

  // A run of deleted or empty rows still has to move the marker, or the same
  // nothing is reconsidered on every pass forever.
  if (usable.length === 0) {
    markAnalysed(target.chat_id, highest)
    return
  }

  const chunk = buildChunk(target, rows)
  recentCalls.push(Date.now())
  let items: AnalysisItem[] = []
  try {
    items = await analyzeConversation(chunk)
  } catch (err) {
    logger.error({ err, chatId: target.chat_id }, '[tg-tier1] analysis failed')
    // The marker stays put: a failed call must not silently skip a conversation.
    return
  }
  noteTier1Call()

  const tally: Record<string, number> = {}
  for (const item of items) {
    const outcome = await applyItem(target, item)
    tally[outcome] = (tally[outcome] ?? 0) + 1
  }

  markAnalysed(target.chat_id, highest)
  logger.info(
    { chatId: target.chat_id, messages: usable.length, items: items.length, ...tally },
    '[tg-tier1] conversation analysed',
  )
}

export async function runTier1Pass(): Promise<number> {
  const budget = getBudget()
  if (budget.tier1_calls >= DAILY_CALL_BUDGET) {
    logger.warn({ calls: budget.tier1_calls }, '[tg-tier1] daily budget spent — analysis paused until midnight')
    return 0
  }
  if (hourlyCalls(Date.now()) >= HOURLY_CALL_BUDGET) return 0

  const nowS = Math.floor(Date.now() / 1000)
  const targets = listAnalysisTargets(BOT_NAME)
  let handled = 0

  for (const t of targets) {
    if (inFlight.has(t.chat_id)) continue
    const decision = shouldFlush({
      pending: t.pending,
      oldestTs: t.oldest_ts,
      newestTs: t.newest_ts,
      lastFlushTs: t.last_flush_ts,
    }, nowS)
    if (!decision.flush) continue

    inFlight.add(t.chat_id)
    try {
      await analyzeChat(t)
      handled++
    } finally {
      inFlight.delete(t.chat_id)
    }

    if (hourlyCalls(Date.now()) >= HOURLY_CALL_BUDGET) break
  }
  return handled
}

/**
 * Sleep until something could plausibly be due.
 *
 * With nothing pending anywhere there is nothing to wake for; with something
 * pending, the deadline is arithmetic rather than a guess.
 */
export function nextSleepMs(targets: AnalysisTarget[], nowS: number): number {
  let soonest: number | null = null
  for (const t of targets) {
    const due = secondsUntilDue({
      pending: t.pending,
      oldestTs: t.oldest_ts,
      newestTs: t.newest_ts,
      lastFlushTs: t.last_flush_ts,
    }, nowS)
    if (due === null) continue
    soonest = soonest === null ? due : Math.min(soonest, due)
  }
  if (soonest === null) return MAX_SLEEP_MS
  return Math.max(MIN_SLEEP_MS, Math.min(MAX_SLEEP_MS, soonest * 1000))
}

function scheduleNext(): void {
  const delay = nextSleepMs(listAnalysisTargets(BOT_NAME), Math.floor(Date.now() / 1000))
  timer = setTimeout(() => {
    void runTier1Pass()
      .catch(err => logger.error({ err }, '[tg-tier1] pass failed'))
      // Re-arm from the end: a model call takes seconds, and a fixed schedule
      // would stack passes on top of each other.
      .finally(() => { if (timer) scheduleNext() })
  }, delay)
}

export function initTier1(): void {
  if (timer) return
  scheduleNext()
  logger.info({ bot: BOT_NAME }, '[tg-tier1] analysing assigned Telegram chats')
}

export function stopTier1(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
