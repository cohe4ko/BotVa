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
import { ALLOWED_CHAT_ID } from './config.js'
import { runAgent } from './agent.js'
import { getBackgroundModel } from './model.js'
import { getSession, setSession } from './db.js'
import { logger } from './logger.js'
import { openObserver, type ObserverSession } from './telegram/bridge.js'
import { businessRouteFor } from './telegram/business.js'
import { checkSendLimits, isSendAllowed } from './telegram/send-policy.js'
import { GrammyError, type Api } from 'grammy'
import { findAutoReplyCandidates, type AutoReplyCandidate } from './telegram/autoreply.js'
import {
  markAutoReplied, getMessages, getMessagesAfter, countMessagesAfter, getOwnerStyleSamples,
  recordOutbox, listAutoReplyChats, setAutoReplyContext, resetAutoReplyContext,
  type TgMessage,
} from './telegram/db.js'

/**
 * History handed to the agent when a chat's session is opened for the first time.
 *
 * This is the whole point of a long-lived session per chat: the bot reads how
 * this particular conversation actually sounds — how the owner answers *this*
 * person, at what length, in which language — once, and carries it from then on.
 */
const PRIMING_MESSAGES = 200

/**
 * The same, for a group — plus a separate block of the owner's own lines.
 *
 * Going deeper into a busy room buys little: the extra messages are mostly
 * other people, and the owner's manner stays just as diluted. The room is read
 * for who-is-who and what it is about; his voice comes from OWN_LINES_IN_GROUP
 * instead, which is the same context spent entirely on signal.
 */
const PRIMING_MESSAGES_GROUP = 150

/** Rooms where most messages are between other people. */
function isGroup(kind: string): boolean {
  return kind === 'group' || kind === 'supergroup' || kind === 'channel'
}

/**
 * Ceiling on what one follow-up turn may carry.
 *
 * A later turn normally shows only what arrived since the session last looked —
 * usually a handful of lines. But the owner can take the conversation over by
 * hand and exchange a hundred messages before dropping off again, and the
 * session has to see that, or it answers a conversation it stopped following.
 * Past this ceiling the prompt says how many lines it had to leave out rather
 * than pretending the gap is not there.
 */
const GAP_MESSAGES = 120

/** Trailing context on a turn where nothing at all is new — a rare fallback. */
const CONTEXT_MESSAGES = 20

/** Owner messages from other chats — only if this chat has almost no history. */
const FALLBACK_SAMPLES = 25

/** The owner's own lines, lifted out of a group transcript as a style block. */
const OWN_LINES_IN_GROUP = 50

/**
 * Below this many of the owner's own lines, a group's archive is too thin to
 * prime from and is topped up from Telegram first.
 *
 * A group is only ever logged from the moment it was switched on, so a chat
 * enabled today has a couple of dozen messages and almost none of his. Without
 * a top-up the very session that is supposed to learn his voice in that room
 * would be primed on nothing.
 */
const SEED_IF_OWN_LINES_BELOW = 15

/**
 * Cap on one of the owner's own messages inside a prompt.
 *
 * A long message of his is trimmed rather than dropped: what it is for here is
 * manner, and the opening carries that. The cap is tighter in the style block
 * (only the voice matters) than in the transcript (where the content may be
 * what the reply hangs on).
 */
const OWN_SAMPLE_CHARS = 300
const OWN_TRANSCRIPT_CHARS = 700

/**
 * Answer that means "say nothing".
 *
 * The bot is speaking as the account holder. It must be able to decline — a
 * question it cannot answer honestly is far better left for the owner than
 * covered with a plausible guess.
 */
const SKIP_TOKEN = 'ПРОПУСК'

/** Set by initAutoReply when this process can reply through Telegram Business. */
let businessApi: Api | undefined

let timer: ReturnType<typeof setTimeout> | null = null
/** Chats currently being answered — a slow agent must not be started twice. */
const inFlight = new Set<string>()

/**
 * Per-chat back-off on the live read-state lookup.
 *
 * The poll itself is free — local reads only — but the one Telegram call it can
 * make sits behind this. A chat that is waiting yet already read stays a
 * candidate indefinitely, and without a back-off a ten-second tick would turn
 * into six dialog lookups a minute for as long as the owner leaves it be.
 * Nothing here is persisted: on restart the first check is allowed again.
 */
const peerCheckUntil = new Map<string, number>()

/** Never re-ask sooner than this, however short the chat's threshold. */
const PEER_CHECK_BACKOFF_MIN_S = 60

function peerCheckBackedOff(chatId: string, nowS: number): boolean {
  const until = peerCheckUntil.get(chatId)
  if (until === undefined) return false
  if (nowS >= until) { peerCheckUntil.delete(chatId); return false }
  return true
}

function backOffPeerCheck(chatId: string, nowS: number, thresholdS: number): void {
  peerCheckUntil.set(chatId, nowS + Math.max(PEER_CHECK_BACKOFF_MIN_S, thresholdS))
}

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
      let body = m.text.trim() || `[${m.media_type ?? 'вкладення'}]`
      // The owner's own long messages are the ones that bloat a group context,
      // and they are also the ones the bot is least likely to be answering.
      if (m.direction === 'out' && body.length > OWN_TRANSCRIPT_CHARS) {
        body = `${body.slice(0, OWN_TRANSCRIPT_CHARS).trimEnd()}… [обрізано]`
      }
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
function guardrails(group: boolean): string[] {
  return [
    '- Одне повідомлення. Без markdown, без списків, без підпису — це живий чат.',
    ...(group
      // Only stated where it applies: a rule about other participants is noise
      // in a chat that has none, and noise is what a model learns to skim.
      ? ['- Відповідай лише на звернення до власника. Не коментуй чужі репліки і не влазь у розмову інших.']
      : []),
    '- Ти — власник акаунта, не асистент. На питання «хто це?», «ти хто?» відповідай так, як відповів би він.',
    '- Не стверджуй конкретики про власника, якої не знаєш: плани, згоду, зобов’язання, суми, дати, адреси, спільне минуле.',
    '- Не знаєш — так і напиши: «не пригадую», «не пам’ятаю такого», «зараз не скажу». Це чесна відповідь, а не вигадка, і вона майже завжди краща за мовчання.',
    `- «${SKIP_TOKEN}» — лише коли будь-яка відповідь означала б щось вигадати або взяти на власника зобов’язання. Незнання, сумнів чи дрібна побутова репліка на це не тягнуть.`,
    `- Якщо мовчиш — поверни «${SKIP_TOKEN}: <причина в кілька слів>». Власник побачить саме цю причину і має зрозуміти з неї, чому відповідь за ним.`,
  ]
}

/**
 * First turn of a chat's session: teach the voice, then ask for one reply.
 *
 * Style is not described here, it is shown — and shown from this conversation
 * specifically, because people write differently to different people. A summary
 * of someone's manner is always thinner than their actual sentences.
 */
export function buildPrimingPrompt(c: AutoReplyCandidate): string {
  const group = isGroup(c.chat.kind)
  // A group needs more to make sense of: several voices, threads that overlap,
  // and far fewer lines of the owner's own per hundred messages.
  const depth = group ? PRIMING_MESSAGES_GROUP : PRIMING_MESSAGES
  const history = readable(getMessages(c.chat.chat_id, depth))
  const ownerLines = history.filter(m => m.direction === 'out' && m.text.trim()).length
  const instruction = c.chat.auto_reply_prompt.trim()

  const parts = [
    group
      ? `Відтепер ти пишеш у груповому чаті «${c.chat.title}» від імені власника акаунта — як один з учасників.`
      : `Відтепер ти ведеш цей чат у Telegram від імені власника акаунта — приватну переписку з «${c.chat.title}».`,
  ]

  if (history.length > 0) {
    parts.push(
      '',
      `Нижче — ${history.length} останніх повідомлень цього чату. Прочитай їх уважно і зрозумій,`,
      group
        ? 'хто тут хто, про що взагалі йдеться, і як власник поводиться саме в цій групі:'
        : 'як власник пише саме цій людині:',
      'мова, довжина реплік, тон, звертання, гумор, пунктуація,',
      'чи ставить крапки, чи вживає емодзі, як починає й завершує розмову, на що взагалі відповідає,',
      'а що лишає без відповіді. Далі ти маєш звучати як він, а не як асистент.',
      '',
      '--- ІСТОРІЯ ПЕРЕПИСКИ (найновіші — внизу) ---',
      transcript(history, c.chat.title),
      '--- КІНЕЦЬ ІСТОРІЇ ---',
    )
  }

  // In a room of several voices the owner's own lines are a small fraction of
  // the transcript, and style is exactly what gets lost in that ratio. Pulling
  // them out separately puts his manner back in front of the model without
  // spending more context on everyone else.
  if (group && ownerLines >= 3) {
    const own = getOwnerStyleSamples(OWN_LINES_IN_GROUP, c.chat.chat_id, OWN_SAMPLE_CHARS)
    if (own.length > 0) {
      parts.push(
        '',
        'А ось лише репліки самого власника в цій групі — саме так він тут звучить:',
        own.map(s => `— ${s}`).join('\n'),
      )
    }
  }

  // A chat with no usable history of the owner's own words cannot teach his
  // voice. Saying so beats letting the model infer a style from nothing — and
  // his words from other chats, while weaker, are at least real.
  if (ownerLines < 5) {
    const samples = getOwnerStyleSamples(FALLBACK_SAMPLES, undefined, OWN_SAMPLE_CHARS)
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
 * Every later turn: everything the session has not seen yet.
 *
 * Not "the last N messages" — the gap between two unattended replies belongs to
 * the owner, and it can be long. If they answered by hand for an hour and then
 * dropped off again, all of that has to reach the session, including their own
 * replies: otherwise the bot resumes from where *it* left off and talks past a
 * conversation that has moved on.
 */
export function buildFollowUpPrompt(c: AutoReplyCandidate): string {
  const seenUpTo = c.chat.auto_reply_ctx_msg_id
  const total = countMessagesAfter(c.chat.chat_id, seenUpTo)
  const rows = total > 0
    ? getMessagesAfter(c.chat.chat_id, seenUpTo, GAP_MESSAGES)
    // Nothing new by id — a re-run after a failure. Show the recent thread so
    // the turn is not asked to answer into a vacuum.
    : getMessages(c.chat.chat_id, CONTEXT_MESSAGES)

  const parts: string[] = []

  if (total > rows.length) {
    parts.push(
      `У цьому чаті з часу твоєї останньої репліки було ${total} повідомлень — нижче лише останні ${rows.length}.`,
      `Решту (${total - rows.length}) ти не бачив; не роби вигляд, що знаєш їхній зміст.`,
      '',
    )
  } else if (readable(rows).some(m => m.direction === 'out')) {
    // The owner spoke here himself. Saying so plainly stops the model from
    // reading its own earlier replies and his as one continuous voice.
    parts.push('Власник частину цієї розмови вів сам — його репліки нижче позначені як ВЛАСНИК.', '')
  }

  parts.push(
    total > 0 ? 'Що сталося в чаті відтоді (найновіші — внизу):' : 'Останні повідомлення в чаті (найновіші — внизу):',
    transcript(rows, c.chat.title),
    '',
    requestBlock(c),
  )
  return parts.join('\n')
}

/** The ask itself, identical on both paths so the limits never drift apart. */
function requestBlock(c: AutoReplyCandidate): string {
  const who = c.trigger.sender_name && c.trigger.sender_name !== c.trigger.sender_id
    ? c.trigger.sender_name
    : null

  const parts: string[] = []

  if (isGroup(c.chat.kind)) {
    // In a group the bot answers one message, not the room. Naming it stops the
    // model from replying to whatever happens to be at the bottom of the log.
    parts.push(
      `У групі до власника звернулися${who ? ` (${who})` : ''}:`,
      `«${(c.trigger.text.trim() || `[${c.trigger.media_type ?? 'вкладення'}]`).slice(0, 500)}»`,
      '',
      `Він не відповів уже ${waitedLabel(c.waitedS)}, тож відповідаєш ти замість нього.`,
      'Відповідай саме на це звернення. Решта розмови — контекст, не привід вступати в неї.',
    )
  } else {
    parts.push(`Власник не відповів уже ${waitedLabel(c.waitedS)}, тож відповідаєш ти замість нього.`)
  }

  parts.push('', 'Межі:', ...guardrails(isGroup(c.chat.kind)), '', 'Поверни тільки текст повідомлення.')
  return parts.join('\n')
}

/**
 * Tell the owner, in his own chat with this bot, that the bot said nothing.
 *
 * Silence is the one outcome with no trace in the conversation itself. Without
 * this the owner has to go looking in an admin page to discover that someone
 * wrote to him, the bot considered it, and decided the answer was his to give —
 * which is exactly the moment he most needs to know.
 */
export async function notifyOwnerOfSilence(c: AutoReplyCandidate, reason: string): Promise<void> {
  if (!ALLOWED_CHAT_ID) return

  const who = c.trigger.sender_name && c.trigger.sender_name !== c.trigger.sender_id
    ? c.trigger.sender_name
    : c.chat.title
  const said = c.trigger.text.trim() || `[${c.trigger.media_type ?? 'вкладення'}]`

  const lines = [
    `🤐 Змовчав у чаті з <b>${escapeHtml(c.chat.title)}</b>`,
    '',
    `<b>${escapeHtml(who)}:</b> ${escapeHtml(said.slice(0, 600))}`,
  ]
  if (reason) lines.push('', `<i>${escapeHtml(reason.slice(0, 400))}</i>`)
  lines.push('', 'Відповідь за тобою.')

  try {
    const { sendMessage } = await import('./bot.js')
    await sendMessage(ALLOWED_CHAT_ID, lines.join('\n'))
  } catch (err) {
    logger.warn({ err, chatId: c.chat.chat_id }, '[tg-autoreply] could not notify the owner')
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Top up a group's local archive before its session is primed.
 *
 * Only for groups, and only for the ones this bot actually answers in: a chat
 * switched on today has whatever catch-up happened to fetch, which is far too
 * little of the owner's own voice to learn from. Two bounded requests, once per
 * chat, at the one moment the depth is needed — never on a schedule and never
 * for a chat nobody asked the bot to handle.
 */
export async function seedGroupArchive(obs: ObserverSession, c: AutoReplyCandidate): Promise<void> {
  if (!isGroup(c.chat.kind)) return

  const own = getOwnerStyleSamples(SEED_IF_OWN_LINES_BELOW, c.chat.chat_id)
  if (own.length >= SEED_IF_OWN_LINES_BELOW) return

  try {
    // No baselining here, unlike the admin path: this runs because a message is
    // already waiting to be answered, and the fetched history is context for
    // that answer, not a backlog to be marked handled.
    const result = await obs.call('tg_seed_chat', {
      chat: c.chat.chat_id,
      limit: PRIMING_MESSAGES_GROUP,
      own_limit: OWN_LINES_IN_GROUP,
    })
    logger.info({ chatId: c.chat.chat_id, result }, '[tg-autoreply] seeded the group archive before priming')
  } catch (err) {
    // A thin archive still primes, just with less to go on — not a reason to
    // abandon the reply.
    logger.warn({ err, chatId: c.chat.chat_id }, '[tg-autoreply] could not seed the group archive')
  }
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
  if (!existing) {
    logger.info({ chatId }, '[tg-autoreply] priming a new session for this chat')
    await seedGroupArchive(obs, c)
  }
  const prompt = existing ? buildFollowUpPrompt(c) : buildPrimingPrompt(c)

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
  //
  // The context marker moves with it: the turn happened, so everything the
  // prompt carried is now inside the session. A crashed run leaves both
  // untouched, and the next pass shows the same messages again rather than
  // skipping over them.
  if (newSessionId) {
    setSession(sessionKey, newSessionId)
    if (existing) setAutoReplyContext(chatId, c.trigger.msg_id)
    else resetAutoReplyContext(chatId, c.trigger.msg_id)
  }

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
    await notifyOwnerOfSilence(c, 'Запуск агента не дав відповіді — це збій, а не рішення.')
    return
  }
  if (answer === SKIP_TOKEN || answer.startsWith(SKIP_TOKEN)) {
    // Deliberate silence still counts as handled: re-asking the same message
    // every minute would burn a model run a minute for the same answer.
    markAutoReplied(chatId, c.trigger.msg_id)
    // "ПРОПУСК: не знаю його планів" — strip the token and whatever punctuation
    // the model used to attach the reason.
    const why = answer.slice(SKIP_TOKEN.length).replace(/^[\s:—–-]+/, '').trim()
    note('агент вирішив змовчати', why)
    logger.info({ chatId }, '[tg-autoreply] agent declined to answer')
    await notifyOwnerOfSilence(c, why)
    return
  }

  await sendAnswer(obs, c, answer)
  markAutoReplied(chatId, c.trigger.msg_id)
  logger.info({ chatId, waitedS: c.waitedS, chars: answer.length }, '[tg-autoreply] replied')
}

/**
 * Send a reply: through Telegram Business when it covers this private chat
 * (official, on the owner's behalf), otherwise through the MTProto observer.
 *
 * Falls back to the observer only when Telegram definitively refused the
 * business send (an API error). A network failure may still have delivered
 * the message, and sending it again the other way would put two copies in
 * the chat under the owner's name.
 */
export async function sendAnswer(obs: ObserverSession, c: AutoReplyCandidate, text: string): Promise<void> {
  const chatId = c.chat.chat_id
  const route = businessApi && c.chat.kind === 'user' ? businessRouteFor(chatId) : null
  if (route && businessApi) {
    // The observer enforces these inside tg_send_message; this route must not
    // be a way around the owner's allowlist or the shared limits.
    if (!isSendAllowed(chatId)) throw new Error(`sending to chat ${chatId} is not allowed (admin: Telegram → Chats)`)
    const limit = checkSendLimits()
    if (limit) throw new Error(limit)
    // Read before answering, as a person would — and as the observer does.
    await (businessApi.raw as any).readBusinessMessage({ business_connection_id: route, chat_id: Number(chatId), message_id: c.trigger.msg_id })
      .catch(() => { /* read receipts are cosmetic; the reply still goes out */ })
    try {
      const m = await businessApi.sendMessage(Number(chatId), text, { business_connection_id: route })
      recordOutbox({ chat_id: chatId, kind: 'auto-reply', text: text.slice(0, 500), status: 'sent', requested_by: `${BOT_NAME} (business)`, msg_id: m.message_id })
      logger.info({ chatId }, '[tg-autoreply] sent through Telegram Business')
      return
    } catch (err) {
      if (!(err instanceof GrammyError)) throw err
      logger.warn({ chatId, code: err.error_code, description: err.description }, '[tg-autoreply] business send refused, using the observer')
    }
  }
  await obs.call('tg_send_message', { chat: chatId, text })
}

/**
 * One pass over this bot's chats.
 *
 * Exported for tests and for a manual kick; the timer is the normal caller.
 */
export async function runAutoReplyPass(nowS = Math.floor(Date.now() / 1000)): Promise<number> {
  const decisions = findAutoReplyCandidates(BOT_NAME, nowS)
  const ready = decisions.filter(d =>
    d.candidate && !inFlight.has(d.chat.chat_id) && !peerCheckBackedOff(d.chat.chat_id, nowS))

  // Nothing to do means nothing is opened, dialled or asked. The pass so far has
  // touched only the local database, which is what makes a short interval safe.
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
            // The owner is present. Back off before asking again — a chat that
            // stays "waiting but read" would otherwise be queried on every tick
            // for as long as it sits there.
            backOffPeerCheck(chatId, nowS, c.chat.auto_reply_after_s)
            logger.info({ chatId }, '[tg-autoreply] chat already read by owner, staying silent')
            continue
          }
        } catch (err) {
          // Unknown read state is not permission to speak — and a failing lookup
          // is exactly what must not be retried in a tight loop.
          backOffPeerCheck(chatId, nowS, c.chat.auto_reply_after_s)
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

/**
 * How often to look, given the thresholds actually in use.
 *
 * A fixed minute of polling silently swallows a 30-second setting: the message
 * becomes eligible, then waits up to another minute for anyone to notice, and
 * the owner sees two minutes where they asked for thirty seconds. The check
 * itself is a handful of indexed SQLite reads with no network at all, so the
 * interval can follow the shortest threshold instead of the other way round.
 *
 * A third of the threshold keeps the added lag well under the setting itself.
 */
export function pollIntervalMs(thresholdsS: number[]): number {
  if (thresholdsS.length === 0) return MAX_POLL_MS
  const shortest = Math.min(...thresholdsS)
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(shortest / 3) * 1000))
}

/** Nothing configured, or every chat on a long threshold. */
const MAX_POLL_MS = 60_000
/** Floor: below this the loop is churning, not watching. */
const MIN_POLL_MS = 5_000

function scheduleNext(): void {
  const thresholds = listAutoReplyChats(BOT_NAME).map(c => c.auto_reply_after_s)
  const delay = pollIntervalMs(thresholds)

  timer = setTimeout(() => {
    void runAutoReplyPass()
      .catch(err => logger.error({ err }, '[tg-autoreply] pass failed'))
      // Re-arm from the end of the pass, not from its start: an agent run takes
      // seconds, and overlapping passes would race for the same chat.
      .finally(() => { if (timer) scheduleNext() })
  }, delay)
}

/**
 * @param api this bot's Bot API client — enables replying through Telegram
 *   Business for chats the owner put under Chat Automation.
 */
export function initAutoReply(api?: Api): void {
  businessApi = api
  if (timer) return
  scheduleNext()
  logger.info({ bot: BOT_NAME }, '[tg-autoreply] watching assigned Telegram chats')
}

export function stopAutoReply(): void {
  if (timer) { clearTimeout(timer); timer = null }
}
