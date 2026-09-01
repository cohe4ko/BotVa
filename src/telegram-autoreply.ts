/**
 * Unattended replies — bot-process side.
 *
 * Runs inside each bot's own process, so "chat X is answered by bot Y" needs no
 * routing: only Y's process picks up the chats assigned to Y. Each observed chat
 * gets one long-lived agent session of its own (`tg:<chat_id>`), so the bot
 * carries the whole history of that conversation from turn to turn instead of
 * meeting the person fresh every time.
 *
 * Live Telegram actions go through the observer daemon over its socket. This
 * process never opens an MTProto connection.
 */

import { BOT_NAME } from './env.js'
import { runAgent } from './agent.js'
import { getBackgroundModel } from './model.js'
import { getSession, setSession } from './db.js'
import { logger } from './logger.js'
import { openObserver, type ObserverSession } from './telegram/bridge.js'
import { findAutoReplyCandidates, type AutoReplyCandidate } from './telegram/autoreply.js'
import { markAutoReplied, getMessages, getOwnerStyleSamples, recordOutbox, type TgMessage } from './telegram/db.js'

/** How often the policy is re-evaluated. Pure SQLite reads — no API calls. */
const POLL_MS = 60_000

/**
 * History handed to the agent when a chat's session is opened for the first time.
 *
 * This is the whole point of a long-lived session per chat: the bot reads how
 * this particular conversation actually sounds — how the owner answers *this*
 * person, at what length, in which language — once, and carries it from then on.
 */
const PRIMING_MESSAGES = 200

/**
 * History repeated on every later turn.
 *
 * Small on purpose. The session already holds everything it was primed with;
 * re-sending hundreds of messages each time would cost a fortune and teach it
 * nothing new. This is just the local thread of the moment.
 */
const CONTEXT_MESSAGES = 20

/** Owner messages from other chats — only if this chat has almost no history. */
const FALLBACK_SAMPLES = 25

/**
 * Answer that means "say nothing".
 *
 * The bot is speaking as the account holder. It must be able to decline — a
 * question it cannot answer honestly is far better left for the owner than
 * covered with a plausible guess.
 */
const SKIP_TOKEN = 'ПРОПУСК'

let timer: ReturnType<typeof setInterval> | null = null
/** Chats currently being answered — a slow agent must not be started twice. */
const inFlight = new Set<string>()

function sessionKeyFor(chatId: string): string {
  // Namespaced: observed Telegram chat ids and this bot's own chat ids are both
  // bare numbers and would otherwise collide in the same sessions table.
  return `tg:${chatId}`
}

/**
 * Rows worth showing the agent.
 *
 * A deleted message is stored with its text blanked, so it renders as an empty
 * placeholder and teaches nothing. A chat where the test traffic was later wiped
 * would otherwise arrive as two hundred lines of "[медіа]" — noise that reads,
 * to a model, like a conversation with no content.
 */
export function readable(rows: TgMessage[]): TgMessage[] {
  return rows.filter(m => !m.deleted_ts && (m.text.trim() || m.media_type))
}

const timeFmt = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
})

export function transcript(rows: TgMessage[], chatTitle: string, ownerLabel = 'ВЛАСНИК'): string {
  return readable(rows)
    .slice()
    .reverse()
    .map(m => {
      // sender_name can fall back to a bare id when the entity was not cached;
      // the chat title is the name a person would actually use.
      const name = m.sender_name && m.sender_name !== m.sender_id ? m.sender_name : chatTitle
      const who = m.direction === 'out' ? ownerLabel : name
      const body = m.text.trim() || `[${m.media_type ?? 'вкладення'}]`
      return `[${timeFmt.format(new Date(m.ts * 1000))}] ${who}: ${body}`
    })
    .join('\n')
}

/** How long the message has been waiting, in words a prompt can use. */
function waitedLabel(seconds: number): string {
  if (seconds < 90) return `${seconds} с`
  return `${Math.round(seconds / 60)} хв`
}

/**
 * Rules that hold no matter what the chat's own instruction says.
 *
 * These are last in the prompt and phrased as limits rather than style, so a
 * per-chat instruction can shape the voice without loosening them.
 */
const GUARDRAILS = [
  '- Одне повідомлення. Без markdown, без списків, без підпису — це живий чат.',
  '- Ти — власник акаунта, не асистент. На питання «хто це?», «ти хто?» відповідай так, як відповів би він.',
  '- Не вигадуй конкретики про власника: плани, згоду, зобов’язання, суми, дати, адреси, домовленості.',
  `- «${SKIP_TOKEN}» — лише коли інакше довелося б щось вигадати або взяти на власника зобов’язання. Дрібна побутова репліка на це не тягне.`,
]

/**
 * First turn of a chat's session: teach the voice, then ask for one reply.
 *
 * Style is not described here, it is shown — and shown from this conversation
 * specifically, because people write differently to different people. A summary
 * of someone's manner is always thinner than their actual sentences.
 */
export function buildPrimingPrompt(c: AutoReplyCandidate): string {
  const history = readable(getMessages(c.chat.chat_id, PRIMING_MESSAGES))
  const ownerLines = history.filter(m => m.direction === 'out' && m.text.trim()).length
  const instruction = c.chat.auto_reply_prompt.trim()

  const parts = [
    `Відтепер ти ведеш цей чат у Telegram від імені власника акаунта — приватну переписку з «${c.chat.title}».`,
  ]

  if (history.length > 0) {
    parts.push(
      '',
      `Нижче — ${history.length} останніх повідомлень цієї переписки. Прочитай їх уважно і зрозумій,`,
      'як власник пише саме цій людині: мова, довжина реплік, тон, звертання, гумор, пунктуація,',
      'чи ставить крапки, чи вживає емодзі, як починає й завершує розмову, на що взагалі відповідає,',
      'а що лишає без відповіді. Далі ти маєш звучати як він, а не як асистент.',
      '',
      '--- ІСТОРІЯ ПЕРЕПИСКИ (найновіші — внизу) ---',
      transcript(history, c.chat.title),
      '--- КІНЕЦЬ ІСТОРІЇ ---',
    )
  }

  // A chat with no usable history of the owner's own words cannot teach his
  // voice. Saying so beats letting the model infer a style from nothing — and
  // his words from other chats, while weaker, are at least real.
  if (ownerLines < 5) {
    const samples = getOwnerStyleSamples(FALLBACK_SAMPLES)
    if (samples.length > 0) {
      parts.push(
        '',
        history.length > 0
          ? 'У цій переписці власник писав мало, тож ось як він пише в інших чатах — бери манеру, не зміст:'
          : 'Історії цієї переписки немає. Ось як власник пише в інших чатах — бери манеру, не зміст:',
        samples.map(s => `— ${s}`).join('\n'),
      )
    }
  }

  if (instruction) parts.push('', 'Окремі вказівки власника для цього чату:', instruction)

  parts.push('', requestBlock(c))
  return parts.join('\n')
}

/**
 * Every later turn: only what is new.
 *
 * The session already carries the priming and every exchange since, so this
 * stays deliberately thin — the recent thread, and the ask.
 */
export function buildFollowUpPrompt(c: AutoReplyCandidate): string {
  const rows = getMessages(c.chat.chat_id, CONTEXT_MESSAGES)
  return [
    'Нові повідомлення в цьому чаті (найновіші — внизу):',
    transcript(rows, c.chat.title),
    '',
    requestBlock(c),
  ].join('\n')
}

/** The ask itself, identical on both paths so the limits never drift apart. */
function requestBlock(c: AutoReplyCandidate): string {
  return [
    `Власник не відповів уже ${waitedLabel(c.waitedS)}, тож відповідаєш ти замість нього.`,
    '',
    'Межі:',
    ...GUARDRAILS,
    '',
    'Поверни тільки текст повідомлення.',
  ].join('\n')
}

/** Text the agent produced when the run failed rather than answered. */
function isFailure(text: string): boolean {
  return text.includes('{{agent.crash}}')
    || text.includes('{{agent.crash.partial}}')
    || text.includes('{{agent.crash.double}}')
    || text.includes('{{agent.error}}')
}

async function answerChat(obs: ObserverSession, c: AutoReplyCandidate): Promise<void> {
  const chatId = c.chat.chat_id
  const sessionKey = sessionKeyFor(chatId)
  const existing = getSession(sessionKey)

  // The expensive lesson is taught once. A session that was never opened — or
  // was cleared because its transcript went bad — gets primed again.
  const prompt = existing ? buildFollowUpPrompt(c) : buildPrimingPrompt(c)
  if (!existing) logger.info({ chatId }, '[tg-autoreply] priming a new session for this chat')

  const { text, newSessionId } = await runAgent(
    prompt,
    existing,
    undefined,
    sessionKey,
    undefined,
    getBackgroundModel(sessionKey),
    undefined,
    undefined,
    undefined,
    // No external MCP servers: this run must not reach for tools, and the
    // observer is driven from here rather than by the agent.
    [],
  )

  // Persist the session even when nothing is sent — the reasoning about why it
  // stayed silent is part of the conversation's history.
  if (newSessionId) setSession(sessionKey, newSessionId)

  const answer = (text ?? '').trim()

  // Silence is a real outcome, not a non-event. It is recorded in the same
  // journal as the sends, so the admin can see the bot considered the message
  // and chose not to speak — otherwise "nothing happened" is indistinguishable
  // from a broken pipeline.
  const note = (reason: string, detail: string) => recordOutbox({
    chat_id: chatId,
    kind: 'auto-reply',
    text: detail.slice(0, 500),
    status: 'skipped',
    error: reason,
    requested_by: BOT_NAME,
  })

  if (!answer || isFailure(answer)) {
    note('запуск агента не дав відповіді', answer)
    logger.warn({ chatId, answer: answer.slice(0, 120) }, '[tg-autoreply] agent produced no usable answer')
    return
  }
  if (answer === SKIP_TOKEN || answer.startsWith(SKIP_TOKEN)) {
    // Deliberate silence still counts as handled: re-asking the same message
    // every minute would burn a model run a minute for the same answer.
    markAutoReplied(chatId, c.trigger.msg_id)
    note('агент вирішив змовчати', answer.slice(SKIP_TOKEN.length).trim())
    logger.info({ chatId }, '[tg-autoreply] agent declined to answer')
    return
  }

  await obs.call('tg_send_message', { chat: chatId, text: answer })
  markAutoReplied(chatId, c.trigger.msg_id)
  logger.info({ chatId, waitedS: c.waitedS, chars: answer.length }, '[tg-autoreply] replied')
}

/**
 * One pass over this bot's chats.
 *
 * Exported for tests and for a manual kick; the timer is the normal caller.
 */
export async function runAutoReplyPass(nowS = Math.floor(Date.now() / 1000)): Promise<number> {
  const decisions = findAutoReplyCandidates(BOT_NAME, nowS)
  const ready = decisions.filter(d => d.candidate && !inFlight.has(d.chat.chat_id))
  if (ready.length === 0) return 0

  let obs: ObserverSession
  try {
    obs = await openObserver()
  } catch (err) {
    logger.warn({ err }, '[tg-autoreply] observer unavailable, skipping pass')
    return 0
  }

  let replied = 0
  try {
    for (const d of ready) {
      const c = d.candidate!
      const chatId = c.chat.chat_id

      // Ask Telegram, not our own counter: the owner may have opened the chat
      // on a phone since the last dialog sync, and answering over someone who
      // is already reading is the worst failure mode this feature has.
      if (c.chat.auto_reply_require_unread) {
        try {
          const state = JSON.parse(await obs.call('tg_chat_state', { chat: chatId })) as { unread: number }
          if (state.unread <= 0) {
            logger.info({ chatId }, '[tg-autoreply] chat already read by owner, staying silent')
            continue
          }
        } catch (err) {
          // Unknown read state is not permission to speak.
          logger.warn({ err, chatId }, '[tg-autoreply] could not confirm unread state, staying silent')
          continue
        }
      }

      inFlight.add(chatId)
      try {
        await answerChat(obs, c)
        replied++
      } catch (err) {
        logger.error({ err, chatId }, '[tg-autoreply] reply failed')
      } finally {
        inFlight.delete(chatId)
      }
    }
  } finally {
    await obs.close()
  }
  return replied
}

export function initAutoReply(): void {
  if (timer) return
  timer = setInterval(() => {
    void runAutoReplyPass().catch(err => logger.error({ err }, '[tg-autoreply] pass failed'))
  }, POLL_MS)
  logger.info({ bot: BOT_NAME, pollMs: POLL_MS }, '[tg-autoreply] watching assigned Telegram chats')
}

export function stopAutoReply(): void {
  if (timer) { clearInterval(timer); timer = null }
}
