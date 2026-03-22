import { Bot, Context, InputFile } from 'grammy'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  TELEGRAPH_ENABLED,
  BOT_NAME,
  BOT_DIR,
  DEBUG_CONTEXT,
} from './config.js'
import { getSession, setSession, clearSession, logUsage, getUsageSince, getChatSetting, deleteChatSetting, logAudit, getApprovedGroups, addApprovedGroup, removeApprovedGroup } from './db.js'
import { runAgent, type UsageStats } from './agent.js'
import { buildMemoryContext, saveConversationTurn } from './memory.js'
import { transcribeAudio, voiceCapabilities, synthesizeSpeech } from './voice.js'
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, buildVideoMessage } from './media.js'
import { logger } from './logger.js'
import { queueRequest, cancelRequest, interruptRequest, clearQueue, isProcessing, addFollowup, getAndClearFollowup, clearCancelled } from './request-queue.js'
import { ProgressReporter } from './progress-reporter.js'
import { isStaleMessage } from './stale-filter.js'
import { isDuplicate, markProcessed } from './deduplication.js'
import { shouldUseTelegraph, createTelegraphPage } from './telegraph.js'
import { editImage } from './imagen.js'
import { getModel } from './model.js'
import { chatT, getChatLang, createBotT, type BotT } from './bot-i18n.js'
import { createBuiltinMcpServer } from './builtin-tools.js'
import { hasSessionTitle } from './session-titles.js'
import { getUserNudge } from './workspace-files.js'
import { classifyReaction } from './auto-react.js'
import { appendFileSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'
import { relayWrite, startRelayPoller, relayClear, type RelayMessage } from './group-relay.js'
import { appendGroupContext, readGroupContext, clearGroupContext } from './group-context.js'
import { escapeHtml, formatForTelegram, splitMessage, formatUsageStats, sendChunked } from './message-format.js'
import { handleSettingsCallback, handleModelCallback, handleSessionCallback, registerSettingsCommands } from './bot-settings.js'

// --- AskUser pending responses ---
const pendingQuestions = new Map<string, {
  resolve: (answer: string) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}>()

const pendingPolls = new Map<string, {
  chatId: number
  options: string[]
  messageId: number
  resolve: (answer: string) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}>()

const ASK_USER_TIMEOUT_MS = 120_000 // 2 min to answer

// --- Permission request pending responses (ask mode) ---
let permissionRequestCounter = 0
const pendingPermissions = new Map<string, {
  resolve: (allowed: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}>()

// --- Pending voice confirmations ---
const pendingVoiceConfirms = new Map<string, {
  transcript: string
  messageId: number
  timeout: ReturnType<typeof setTimeout>
}>()

// --- Pending group approvals ---
const pendingGroupApprovals = new Map<string, {
  chatId: number
  chatTitle: string
  timeout: ReturnType<typeof setTimeout>
}>()

// --- Auth ---

// In-memory cache for dynamically approved groups
let approvedGroupsCache: Set<string> | null = null

function loadApprovedGroups(): Set<string> {
  if (!approvedGroupsCache) {
    approvedGroupsCache = new Set(getApprovedGroups())
  }
  return approvedGroupsCache
}

function refreshApprovedGroups(): void {
  approvedGroupsCache = null
}

function isAuthorised(chatId: number): boolean {
  if (!ALLOWED_CHAT_ID) return true // first-run mode
  const allowed = ALLOWED_CHAT_ID.split(',').map(s => s.trim())
  if (allowed.includes(String(chatId))) return true
  // Check dynamically approved groups
  return loadApprovedGroups().has(String(chatId))
}

// --- Group chat support ---

function isGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type
  return type === 'group' || type === 'supergroup'
}

/** Check if this bot is @mentioned in the message (entities or text fallback) */
function isBotMentioned(ctx: Context): boolean {
  const botUsername = ctx.me?.username
  if (!botUsername) return false
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  // Check entities first (standard Telegram mention parsing)
  const hasEntity = entities.some(e =>
    e.type === 'mention' &&
    text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername.toLowerCase()}`
  )
  if (hasEntity) return true
  // Fallback: check text content (HTML parse_mode may not create entities for @mentions)
  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)
}

/** Check if this message is a reply to one of the bot's messages */
function isReplyToBot(ctx: Context): boolean {
  return ctx.message?.reply_to_message?.from?.id === ctx.me?.id
}

/**
 * Determine if the bot should process a group message.
 * Rules:
 * - Must be @mentioned or replied to
 * - Sender must be authorised user (their user ID is in ALLOWED_CHAT_ID) OR a bot (for ping-pong)
 * - Other people in the group are ignored
 */
function shouldProcessGroupMessage(ctx: Context): boolean {
  // Must be mentioned or replied to
  if (!isBotMentioned(ctx) && !isReplyToBot(ctx)) return false
  const sender = ctx.message?.from
  if (!sender) return false
  // Allow bots (for multi-bot ping-pong dialogue)
  if (sender.is_bot) return true
  // Allow authorised users (their user ID = their private chat ID in ALLOWED_CHAT_ID)
  return isAuthorised(sender.id)
}

// --- Debate logging ---

const DEBATE_LOG_PATH = pathResolve(BOT_DIR, 'debate.log')

function debateLog(chatId: string, event: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${BOT_NAME}] [chat:${chatId}] ${event}${data ? ' ' + JSON.stringify(data) : ''}\n`
  try { appendFileSync(DEBATE_LOG_PATH, line) } catch { /* ignore */ }
  logger.info({ chatId, event, ...data }, `debate: ${event}`)
}

// --- Plan mode state (planning → executing transition) ---

interface PlanModeState {
  phase: 'planning' | 'executing'
  startedAt: number
}

const planModeState = new Map<string, PlanModeState>()

function getPlanPhase(chatId: string): 'planning' | 'executing' | null {
  return planModeState.get(chatId)?.phase ?? null
}

function setPlanPhase(chatId: string, phase: 'planning' | 'executing'): void {
  planModeState.set(chatId, { phase, startedAt: Date.now() })
}

function clearPlanState(chatId: string): void {
  planModeState.delete(chatId)
}

// --- Group debate state (tracks partner bot for auto @mention) ---

interface DebateState {
  partnerUsername: string   // other bot's @username (without @)
  myRole: 'asker' | 'answerer'
  startedAt: number
}

const groupDebateState = new Map<string, DebateState>()

/** Parse debate roles from user's initial message.
 *  Expects: "@AskerBot питає, @AnswererBot відповідає" (any order) */
function parseDebateRoles(text: string, myUsername: string): DebateState | null {
  // Match both possible patterns: "питає" / "відповідає" or "asks" / "answers"
  const mentionRe = /@(\w+)/g
  const mentions: string[] = []
  let m
  while ((m = mentionRe.exec(text)) !== null) mentions.push(m[1])
  if (mentions.length < 2) return null

  const lower = text.toLowerCase()
  const myLower = myUsername.toLowerCase()

  // Find which mention is asker and which is answerer
  for (const mention of mentions) {
    const mentionLower = mention.toLowerCase()
    const mentionIdx = lower.indexOf(`@${mentionLower}`)
    if (mentionIdx === -1) continue

    // Check what follows this mention
    const after = lower.slice(mentionIdx + mention.length + 1, mentionIdx + mention.length + 30)
    const isAsker = /\s*(питає|питач|asks?|asker)/.test(after)
    const isAnswerer = /\s*(відповідає|відповідач|answers?|answerer)/.test(after)

    if (isAsker && mentionLower === myLower) {
      // I'm the asker — partner is the other mention
      const partner = mentions.find(m => m.toLowerCase() !== myLower)
      if (partner) return { partnerUsername: partner, myRole: 'asker', startedAt: Date.now() }
    }
    if (isAnswerer && mentionLower === myLower) {
      const partner = mentions.find(m => m.toLowerCase() !== myLower)
      if (partner) return { partnerUsername: partner, myRole: 'answerer', startedAt: Date.now() }
    }
    if (isAsker && mentionLower !== myLower) {
      // Other bot is asker — I'm answerer
      return { partnerUsername: mention, myRole: 'answerer', startedAt: Date.now() }
    }
    if (isAnswerer && mentionLower !== myLower) {
      return { partnerUsername: mention, myRole: 'asker', startedAt: Date.now() }
    }
  }
  return null
}

function getDebateState(chatId: string): DebateState | undefined {
  return groupDebateState.get(chatId)
}

function resetDebateState(chatId: string): void {
  groupDebateState.delete(chatId)
}

/** Extract retry_after from Grammy/Telegram 429 errors (multiple locations + fallback to message parsing) */
function extractRetryAfter(err: any): number | undefined {
  const ra = err?.parameters?.retry_after
    ?? err?.payload?.parameters?.retry_after
    ?? err?.error?.parameters?.retry_after
  if (typeof ra === 'number' && ra > 0) return ra
  // Fallback: parse from error message string "retry after NN"
  const match = String(err).match(/retry after (\d+)/i)
  if (match) return parseInt(match[1], 10)
  return undefined
}

// --- Group stop flag (persists until human sends new message) ---
const stoppedChats = new Set<string>()
const pausedChats = new Set<string>()

// --- Group iteration counter (anti-loop) ---

const groupIterations = new Map<string, { count: number, max: number, startedAt: number }>()
const GROUP_MAX_ITERATIONS = 20
const GROUP_TIMEOUT_MS = 30 * 60 * 1000 // 30 min auto-reset

function getGroupState(chatId: string) {
  const state = groupIterations.get(chatId)
  if (state && Date.now() - state.startedAt > GROUP_TIMEOUT_MS) {
    groupIterations.delete(chatId)
    return undefined
  }
  return state
}

function incrementGroupIteration(chatId: string): boolean {
  let state = getGroupState(chatId)
  if (!state) {
    state = { count: 0, max: GROUP_MAX_ITERATIONS, startedAt: Date.now() }
    groupIterations.set(chatId, state)
  }
  state.count++
  return state.count <= state.max
}

function resetGroupIterations(chatId: string): void {
  groupIterations.delete(chatId)
}

/** Build prefix with sender info for group messages */
function buildGroupPrefix(ctx: Context): string {
  const sender = ctx.message?.from
  if (!sender) return ''
  const name = sender.first_name + (sender.last_name ? ` ${sender.last_name}` : '')
  const username = sender.username ? `@${sender.username}` : ''
  const isBot = sender.is_bot ? ' [bot]' : ''
  return `[Group message from ${name} ${username}${isBot}]\n`
}

// --- Group delay (anti-race, natural pacing) ---

const GROUP_DELAY_MIN_MS = 10_000
const GROUP_DELAY_MAX_MS = 30_000

function randomGroupDelay(): number {
  return GROUP_DELAY_MIN_MS + Math.floor(Math.random() * (GROUP_DELAY_MAX_MS - GROUP_DELAY_MIN_MS))
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// --- Group send + relay ---

/** Send response in group mode. Writes full text to relay for other bots. */
async function sendGroupChunked(ctx: Context, text: string): Promise<void> {
  const chatIdStr = String(ctx.chat?.id)
  const debate = getDebateState(chatIdStr)

  // Strip any @mention agent might have added (relay handles delivery, not @mentions)
  if (debate) {
    const partnerMentionRe = new RegExp(`^\\s*(?:(?:Питання|Відповідь)\\s+для\\s+)?@${debate.partnerUsername}[:\\s]*`, 'i')
    text = text.replace(partnerMentionRe, '').trimStart()
  }

  debateLog(chatIdStr, 'SEND', { hasDebate: !!debate, textPreview: text.slice(0, 100) })

  // Write to relay FIRST (before Telegram send) so other bots get the message
  // even if Telegram send fails for some chunks.
  // Skip relay for answerer's first message (confirmation like "Ready, waiting for questions").
  const chatState = getGroupState(chatIdStr)
  const isAnswererFirstMsg = debate?.myRole === 'answerer' && chatState && chatState.count <= 1
  if (stoppedChats.has(chatIdStr)) {
    debateLog(chatIdStr, 'RELAY_SKIP_STOPPED')
  } else if (!isAnswererFirstMsg) {
    try {
      relayWrite(chatIdStr, ctx.me?.username ?? BOT_NAME, text)
      debateLog(chatIdStr, 'RELAY_WRITTEN', { chars: text.length })
    } catch (err) {
      debateLog(chatIdStr, 'RELAY_WRITE_ERROR', { error: String(err) })
    }
  } else {
    debateLog(chatIdStr, 'RELAY_SKIP_ANSWERER_FIRST', { textPreview: text.slice(0, 80) })
  }

  // Use Telegraph for long group messages to avoid 429 rate limits
  if (TELEGRAPH_ENABLED && shouldUseTelegraph(text)) {
    try {
      const title = `${ctx.me?.first_name ?? BOT_NAME}`
      const url = await createTelegraphPage(title, text)
      if (url) {
        // Send short preview + link to Telegram
        const preview = text.replace(/[#*_~`>|]/g, '').slice(0, 200).trim()
        const msg = `${preview}...\n\n📖 <a href="${url}">Читати повністю</a>`
        try {
          await ctx.reply(msg, { parse_mode: 'HTML' })
        } catch {
          await ctx.reply(`${preview}...\n\n📖 ${url}`).catch(() => {})
        }
        debateLog(chatIdStr, 'TELEGRAPH_SENT', { url, chars: text.length })
        return
      }
    } catch (err) {
      debateLog(chatIdStr, 'TELEGRAPH_ERROR', { error: String(err) })
      // Fall through to chunked send
    }
  }

  // Send chunks to Telegram (with retry on 429 rate limit)
  const formatted = formatForTelegram(text)
  const chunks = splitMessage(formatted)
  for (const chunk of chunks) {
    let sent = false
    for (let attempt = 0; attempt < 3 && !sent; attempt++) {
      try {
        await ctx.reply(chunk, { parse_mode: 'HTML' })
        sent = true
      } catch (err: any) {
        const retryAfter = extractRetryAfter(err)
        if (retryAfter && attempt < 2) {
          debateLog(chatIdStr, 'RATE_LIMITED', { retryAfter, attempt })
          await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000))
          continue
        }
        // Try plain text fallback
        try {
          await ctx.reply(chunk.replace(/<[^>]+>/g, ''))
          sent = true
        } catch (err2: any) {
          const retryAfter2 = extractRetryAfter(err2)
          if (retryAfter2 && attempt < 2) {
            debateLog(chatIdStr, 'RATE_LIMITED', { retryAfter: retryAfter2, attempt })
            await new Promise(r => setTimeout(r, (retryAfter2 + 1) * 1000))
            continue
          }
          debateLog(chatIdStr, 'SEND_CHUNK_ERROR', { error: String(err2), chunkLen: chunk.length })
        }
      }
    }
  }
}

// --- Main handler ---

async function handleMessage(
  ctx: Context,
  rawText: string,
  forceVoiceReply = false,
  fromRelay = false
): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  // Group chat: check mention + sender auth
  const inGroup = isGroupChat(ctx) || fromRelay
  if (inGroup) {
    if (!isAuthorised(chatId)) {
      debateLog(String(chatId), 'SKIP:not_authorised_group')
      return
    }

    if (!fromRelay) {
      // Normal Telegram message: check mention/reply
      const mentioned = isBotMentioned(ctx)
      const replied = isReplyToBot(ctx)
      const senderInfo = ctx.message?.from
      debateLog(String(chatId), 'MSG_RECEIVED', {
        from: senderInfo?.username || senderInfo?.first_name,
        isBot: senderInfo?.is_bot,
        mentioned,
        replied,
        textPreview: rawText.slice(0, 100),
      })
      // During active debate, allow human messages through (they become context injection)
      const hasActiveDebate = !!getDebateState(String(chatId))
      const isHumanDuringDebate = hasActiveDebate && senderInfo && !senderInfo.is_bot
      if (!isHumanDuringDebate && !shouldProcessGroupMessage(ctx)) {
        debateLog(String(chatId), 'SKIP:should_not_process', { mentioned, replied, senderId: senderInfo?.id, senderIsBot: senderInfo?.is_bot })
        return
      }
    } else {
      // Relay message: always process (already filtered by relay module)
      debateLog(String(chatId), 'RELAY_RECEIVED', { textPreview: rawText.slice(0, 100) })
    }

    // If chat was /stopped or /paused, block relay messages. Human message clears the flag.
    const chatIdStr = String(chatId)
    const sender = ctx.message?.from

    // Human message during active debate = context injection (before iteration counter)
    const activeDebate = getDebateState(chatIdStr)
    if (activeDebate && !fromRelay && sender && !sender.is_bot) {
      // Stopped chat: human message clears stop flag but doesn't inject context (starts fresh)
      if (stoppedChats.has(chatIdStr)) {
        stoppedChats.delete(chatIdStr)
        // Fall through to normal processing (new debate)
      } else if (pausedChats.has(chatIdStr)) {
        // Paused: inject context AND resume
        pausedChats.delete(chatIdStr)
        appendGroupContext(chatIdStr, rawText)
        await ctx.api.sendMessage(chatId, `📌 Додано до контексту. Діалог відновлено.`).catch(() => {})
        debateLog(chatIdStr, 'CONTEXT_INJECTED_AND_RESUMED', { text: rawText.slice(0, 100) })
        // Write resume signal to relay so bots pick up
        try {
          relayWrite(chatIdStr, ctx.me?.username ?? BOT_NAME, '[System: debate resumed — continue from where you left off]')
        } catch { /* ignore */ }
        return
      } else {
        // Active debate, not paused/stopped: pure context injection
        appendGroupContext(chatIdStr, rawText)
        await ctx.api.sendMessage(chatId, `📌 Додано до контексту`).catch(() => {})
        debateLog(chatIdStr, 'CONTEXT_INJECTED', { text: rawText.slice(0, 100) })
        return
      }
    }

    if (stoppedChats.has(chatIdStr)) {
      if (fromRelay) {
        debateLog(chatIdStr, 'SKIP:stopped')
        return
      }
      // Human message (no active debate) — allow new debate
      stoppedChats.delete(chatIdStr)
    }
    if (pausedChats.has(chatIdStr)) {
      if (fromRelay) {
        debateLog(chatIdStr, 'SKIP:paused')
        return
      }
      // Human message — resume from pause
      pausedChats.delete(chatIdStr)
      debateLog(chatIdStr, 'RESUMED_BY_HUMAN')
    }

    // Anti-loop: check iteration counter
    if (!incrementGroupIteration(chatIdStr)) {
      const state = getGroupState(chatIdStr)
      debateLog(chatIdStr, 'SKIP:iteration_limit', { count: state?.count, max: state?.max })
      if (state && state.count === state.max + 1) {
        await ctx.api.sendMessage(chatId, `🛑 Ліміт ітерацій (${state.max}). /stop для reset.`).catch(() => {})
      }
      return
    }
    // Parse debate roles from first message (user's initial prompt)
    const chatState = getGroupState(chatIdStr)
    debateLog(chatIdStr, 'ITERATION', { count: chatState?.count, senderIsBot: sender?.is_bot ?? fromRelay })
    if (chatState && chatState.count === 1 && sender && !sender.is_bot && ctx.me?.username) {
      const debate = parseDebateRoles(rawText, ctx.me.username)
      if (debate) {
        groupDebateState.set(chatIdStr, debate)
        debateLog(chatIdStr, 'DEBATE_ROLES_PARSED', { myRole: debate.myRole, partner: debate.partnerUsername })
      } else {
        debateLog(chatIdStr, 'DEBATE_ROLES_NOT_FOUND', { myUsername: ctx.me.username, textPreview: rawText.slice(0, 200) })
      }
    }

    // Add sender context prefix (for relay, it's already in rawText)
    if (!fromRelay) {
      rawText = buildGroupPrefix(ctx) + rawText
    }

    // Random delay for group messages (natural pacing, prevents race conditions)
    // Skip delay on first message (user's initial prompt) — only delay during active debate
    if (chatState && chatState.count > 1) {
      const delayMs = randomGroupDelay()
      const delaySec = Math.round(delayMs / 1000)
      debateLog(chatIdStr, 'DELAY', { seconds: delaySec, count: chatState.count })
      await ctx.api.sendMessage(chatId, `⏳ Прийняв. Думаю ${delaySec}с...`).catch(() => {})
      await sleep(delayMs)
      // Re-check stopped/paused after delay (user may have sent /stop during sleep)
      if (stoppedChats.has(chatIdStr)) {
        debateLog(chatIdStr, 'SKIP:stopped_after_delay')
        return
      }
      if (pausedChats.has(chatIdStr)) {
        debateLog(chatIdStr, 'SKIP:paused_after_delay')
        return
      }
    } else {
      debateLog(chatIdStr, 'NO_DELAY', { count: chatState?.count })
    }
    debateLog(chatIdStr, 'PROCESSING', { debateActive: !!getDebateState(chatIdStr) })
  } else if (!isAuthorised(chatId)) {
    await ctx.reply(chatT(String(chatId))('auth.denied', { chatId }))
    return
  }

  // Stale filter
  const messageDate = ctx.message?.date
  if (messageDate && isStaleMessage(messageDate)) {
    logger.debug({ chatId, messageDate }, 'Skipping stale message')
    return
  }

  // Deduplication
  const messageId = ctx.message?.message_id
  if (messageId) {
    if (isDuplicate(messageId)) {
      logger.debug({ chatId, messageId }, 'Skipping duplicate message')
      return
    }
    markProcessed(messageId)
  }

  const chatIdStr = String(chatId)

  logger.info({ chatId: chatIdStr, len: rawText.length }, 'Message received')

  // Queue the request
  await queueRequest(chatIdStr, async () => {
    let currentMessage = rawText

    // Progress reporter persists across follow-up iterations
    const delaySetting = getChatSetting(chatIdStr, 'progress_delay')
    const delayMs = delaySetting === 'inf' ? Infinity : delaySetting ? parseInt(delaySetting, 10) * 1000 : undefined
    const cuteMode = getChatSetting(chatIdStr, 'progress_style') === 'blonde'
    const lang = getChatLang(chatIdStr)
    const reporter = new ProgressReporter(chatId, ctx.api, delayMs, cuteMode, lang)

    // Loop: run agent, check for follow-up messages (like typing in CLI while agent runs)
    while (true) {
      // Build memory context (in debate mode: keep diaries but skip short-term episodic memories)
      const isDebateMode = inGroup && !!getDebateState(chatIdStr)
      const memoryCtx = await buildMemoryContext(chatIdStr, currentMessage, { skipShortTermMemories: isDebateMode })
      let fullMessage = memoryCtx
        ? `[Short-term context — fades over time. Use SaveFact for permanent storage.]\n${memoryCtx}\n\n${currentMessage}`
        : currentMessage

      // Inject user-added group context (human messages during debate)
      const groupCtx = inGroup ? readGroupContext(chatIdStr) : null
      if (groupCtx) {
        fullMessage = `[📌 Контекст від користувача]\n${groupCtx}\n\n${fullMessage}`
      }

      // Plan mode: prompt injection + approval detection
      const agentMode = getChatSetting(chatIdStr, 'agent_mode') ?? 'full'
      if (agentMode === 'plan') {
        const trimmed = currentMessage.trim()

        // Detect plan approval / exit from user (AskUser button responses)
        if (getPlanPhase(chatIdStr) === 'planning') {
          const approvalRe = /^(виконувати|виконати|execute|так[,. ]*(роби|виконуй)|go|do it|ок[,. ]*(роби|давай)|погнали|запускай)/i
          const saveExitRe = /^(зберегти й вийти|save.*(exit|plan)|зберегти план)/i
          const exitRe = /^(вийти з планування|exit plan|скасувати план|cancel plan)/i

          if (approvalRe.test(trimmed)) {
            setPlanPhase(chatIdStr, 'executing')
          } else if (saveExitRe.test(trimmed)) {
            // Agent will handle saving plan file + SendMedia, then we exit plan mode
            clearPlanState(chatIdStr)
            deleteChatSetting(chatIdStr, 'agent_mode')
            fullMessage = `[📄 SAVE PLAN & EXIT]\nUser wants to save the plan and exit planning mode. Save the plan to a file and send it via SendMedia. Do NOT execute the plan. After sending, confirm that plan mode is deactivated.\n\n${fullMessage}`
            // Skip normal plan injection below
          } else if (exitRe.test(trimmed)) {
            clearPlanState(chatIdStr)
            deleteChatSetting(chatIdStr, 'agent_mode')
            fullMessage = currentMessage  // Pass through as regular message in full mode
          }
        }

        // Initialize planning phase if not set (and not already exited above)
        if (getChatSetting(chatIdStr, 'agent_mode') === 'plan') {
          if (!getPlanPhase(chatIdStr)) {
            setPlanPhase(chatIdStr, 'planning')
          }

          // Inject plan mode context
          if (getPlanPhase(chatIdStr) === 'planning') {
            fullMessage = `[🔍 PLAN MODE — Research & Plan]\nYou are in planning mode. Research the task: read files, search, analyze. Then create a structured plan with steps, files to modify, risks.\nIMPORTANT: Before asking for approval, ALWAYS publish the full plan via PublishTelegraph (title: "План: <task summary>") and send the link to the user. Then ask for approval via AskUser(["Виконувати", "Скоригувати", "Зберегти й вийти", "Вийти з планування"]).\nWrite operations are blocked until approved. Do NOT attempt to execute changes — only plan.\n\n${fullMessage}`
          } else if (getPlanPhase(chatIdStr) === 'executing') {
            fullMessage = `[⚡ EXECUTING PLAN — approved by user]\nThe user approved your plan. Execute it now. All tools are available.\n\n${fullMessage}`
          }
        }
      } else {
        // Not in plan mode — clear any stale plan state
        clearPlanState(chatIdStr)
      }

      // Get session
      const sessionId = getSession(chatIdStr)

      // Nudge LLM to name untitled sessions
      if (sessionId && !hasSessionTitle(sessionId)) {
        fullMessage += '\n\n[Session has no title yet. Call NameSession now with a short 3-5 word title.]'
      }

      // Nudge LLM to gather user data if USER.md is incomplete
      const userNudge = getUserNudge(BOT_DIR)
      if (userNudge) {
        fullMessage += '\n\n' + userNudge
      }

      // Start typing
      const sendTyping = () => ctx.api.sendChatAction(chatId, 'typing').catch(() => {})
      await sendTyping()

      // Create askUser callback for AskUser builtin tool
      const askUserCallback = async (question: string, options: { label: string; description?: string }[], keyboardMode: 'inline' | 'reply' | 'poll', customText?: string, customParseMode?: 'HTML' | 'MarkdownV2' | 'Markdown', multiple?: boolean) => {
        // Legacy: reply keyboard breaks agent flow, convert to inline
        if (keyboardMode === 'reply') keyboardMode = 'inline'

        // Poll mode: native Telegram poll
        if (keyboardMode === 'poll') {
          const pollOptions = options.map(o => o.label)
          const msg = await ctx.api.sendPoll(chatId, question, pollOptions, {
            is_anonymous: false,
            allows_multiple_answers: multiple ?? false,
          })

          const pollId = msg.poll!.id

          return new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingPolls.delete(pollId)
              // Close the poll on timeout
              ctx.api.stopPoll(chatId, msg.message_id).catch(() => {})
              reject(new Error('timeout'))
            }, ASK_USER_TIMEOUT_MS)
            pendingPolls.set(pollId, { chatId, options: pollOptions, messageId: msg.message_id, resolve, reject, timeout })
          })
        }

        let msgText: string
        let parseMode: 'HTML' | 'MarkdownV2' | 'Markdown' | undefined

        if (customText) {
          msgText = customText
          parseMode = customParseMode // use provided or none
        } else {
          parseMode = customParseMode ?? 'HTML'
          const descriptions = options.filter(o => o.description).map(o => `• <b>${escapeHtml(o.label)}</b> — ${escapeHtml(o.description!)}`)
          msgText = descriptions.length > 0
            ? `❓ <b>${escapeHtml(question)}</b>\n\n${descriptions.join('\n')}`
            : `❓ <b>${escapeHtml(question)}</b>`
        }

        // Inline keyboard (default)
        const inlineKeyboard = options.map(o => [{ text: o.label, callback_data: `ask:${o.label}` }])
        inlineKeyboard.push([{ text: chatT(chatIdStr)('cb.askSkip'), callback_data: 'ask:__skip__' }])

        await ctx.api.sendMessage(chatId, msgText, {
          ...(parseMode ? { parse_mode: parseMode } : {}),
          reply_markup: { inline_keyboard: inlineKeyboard },
        })

        return new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingQuestions.delete(chatIdStr)
            reject(new Error('timeout'))
          }, ASK_USER_TIMEOUT_MS)
          pendingQuestions.set(chatIdStr, { resolve, reject, timeout })
        })
      }

      // Auto-react: fire-and-forget emoji reaction based on embedding similarity (0 tokens)
      classifyReaction(currentMessage).then(emoji => {
        if (emoji) {
          const messageId = ctx.message?.message_id
          if (messageId) {
            ctx.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: emoji as any }])
              .catch(() => {}) // silent — reaction is cosmetic
          }
        }
      }).catch(() => {})

      // Create builtin MCP server (image gen, voice, telegraph, media sending)
      const builtin = await createBuiltinMcpServer(ctx, chatId, askUserCallback)

      // Run agent
      let text: string | null
      let newSessionId: string | undefined
      let usage: UsageStats | undefined
      const startTime = Date.now()
      try {
        const auditHandler = (event: import('@anthropic-ai/claude-agent-sdk').SDKMessage) => {
          reporter.handleEvent(event)
          // Log tool calls to audit
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content as any[]) {
              if (block.type === 'tool_use') {
                logAudit(chatIdStr, 'tool_call', `${block.name}${block.input?.file_path ? ': ' + block.input.file_path : block.input?.command ? ': ' + String(block.input.command).slice(0, 100) : ''}`)
              }
            }
          }
          if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
            logAudit(chatIdStr, 'session_start', event.session_id)
          }
        }
        const currentModel = getModel(chatIdStr)
        const agentModeForRun = getChatSetting(chatIdStr, 'agent_mode') ?? 'full'
        const planPhase = agentModeForRun === 'plan' ? (getPlanPhase(chatIdStr) ?? 'planning') : null
        const permissionMode = planPhase === 'planning' ? 'plan'
          : planPhase === 'executing' ? undefined  // full access after approval
          : isDebateMode ? 'debate'
          : undefined
        logger.info({ chatId: chatIdStr, model: currentModel, agentMode: agentModeForRun, planPhase, hasSession: !!sessionId }, 'Running agent')

        // Permission callback for ask mode
        const onPermissionRequest = agentModeForRun === 'ask' ? async (toolName: string, summary: string) => {
          const requestId = `${chatIdStr}:${++permissionRequestCounter}`
          const msg = `🔐 <b>${escapeHtml(toolName)}</b>\n<code>${escapeHtml(summary)}</code>`
          const keyboard = [
            [{ text: '✅ Дозволити', callback_data: `perm:allow:${requestId}` },
             { text: '❌ Заборонити', callback_data: `perm:deny:${requestId}` }],
          ]
          await ctx.api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } })
          return new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              pendingPermissions.delete(requestId)
              resolve(false) // timeout = deny
            }, ASK_USER_TIMEOUT_MS)
            pendingPermissions.set(requestId, { resolve, timeout })
          })
        } : undefined

        // Debug: save full context to file right before agent call
        if (DEBUG_CONTEXT) {
          try {
            const { writeFileSync } = await import('fs')
            const { resolve: pathRes } = await import('path')
            const debugPath = pathRes(BOT_DIR, 'store', 'debug-context.txt')
            const ts = new Date().toISOString()
            writeFileSync(debugPath, `# Debug Context — ${ts}\n# Session: ${sessionId ?? 'new'}\n# Chat: ${chatIdStr}\n\n${fullMessage}`, 'utf-8')
          } catch { /* ignore */ }
        }

        const result = await runAgent(fullMessage, sessionId, sendTyping, chatIdStr, auditHandler, currentModel, builtin?.server, permissionMode, onPermissionRequest)
        text = result.text
        newSessionId = result.newSessionId
        usage = result.usage
      } catch (err) {
        logAudit(chatIdStr, 'error', err instanceof Error ? err.message : String(err))
        throw err
      } finally {
        // Always clean up plan state — even on error
        if (planPhase) {
          clearPlanState(chatIdStr)
        }
      }

      // Update session
      if (newSessionId) {
        const oldSessionId = sessionId
        setSession(chatIdStr, newSessionId)
        // Fire-and-forget: consolidate previous session in background
        if (oldSessionId && oldSessionId !== newSessionId) {
          import('./consolidate.js').then(({ consolidateSession }) =>
            consolidateSession(oldSessionId, chatIdStr, BOT_DIR)
              .catch(err => logger.warn({ err, oldSessionId }, 'Session consolidation failed'))
          )
        }
      }

      // Proactive fact extraction when context is filling up (>70%)
      if (usage && usage.contextWindow > 0 && newSessionId) {
        const contextPct = usage.lastTurnContextTokens / usage.contextWindow
        if (contextPct > 0.70) {
          import('./consolidate.js').then(({ extractFactsMidSession }) =>
            extractFactsMidSession(newSessionId!, chatIdStr, BOT_DIR)
              .catch(err => logger.warn({ err }, 'Mid-session fact extraction failed'))
          )
        }
      }

      // Check for follow-up BEFORE cleanup — reuse reporter if continuing
      const followup = getAndClearFollowup(chatIdStr)
      if (followup) {
        // Add separator line, keep writing to same progress message
        reporter.addFollowupMarker(followup)
        clearCancelled(chatIdStr)
        logger.info({ chatId: chatIdStr }, 'Follow-up received, resuming with new message')
        // Wrap follow-up so agent processes it AND continues original task
        currentMessage = chatT(chatIdStr)('followup.prefix', { text: followup })
        continue
      }

      // No follow-up — normal cleanup (delayed delete)
      await reporter.cleanup()
      builtin?.cleanup?.()

      // No follow-up — send the result
      if (!text) {
        await ctx.reply(chatT(chatIdStr)('auth.noReply'))
        return
      }

      // Translate agent error markers {{key}} to localized text
      const t = chatT(chatIdStr)
      text = text.replace(/\{\{([a-z._]+)\}\}/g, (_, key) => t(key))

      // Save memory
      await saveConversationTurn(chatIdStr, currentMessage, text)

      // Log usage
      const responseTimeMs = Date.now() - startTime
      if (usage) {
        logUsage(chatIdStr, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens, usage.costUSD, responseTimeMs)
        logger.info({ chatId: chatIdStr, ms: responseTimeMs, cost: `$${usage.costUSD.toFixed(4)}`, in: usage.inputTokens, out: usage.outputTokens }, 'Response sent')
      }

      // Send text
      if (inGroup) {
        // Group mode: telegraph for debates, chunked otherwise
        await sendGroupChunked(ctx, text)
      } else {
        // Private chat: telegraph for long messages
        const agentUsedTelegraph = builtin?.usedTools.has('PublishTelegraph')
        const shouldTelegraph = TELEGRAPH_ENABLED && shouldUseTelegraph(text) && !agentUsedTelegraph
        if (shouldTelegraph) {
          const url = await createTelegraphPage(BOT_NAME, text)
          if (url) {
            await ctx.reply(url)
          } else {
            await sendChunked(ctx, text)
          }
        } else {
          await sendChunked(ctx, text)
        }
      }

      // Usage stats footer
      if (usage && getChatSetting(chatIdStr, 'stats') === '1') {
        const statsLine = formatUsageStats(usage)
        await ctx.reply(statsLine, { parse_mode: 'HTML' })
      }

      // Voice reply async — skip if agent already used TextToSpeech
      const shouldVoice = (forceVoiceReply || getChatSetting(chatIdStr, 'voice') === '1')
        && !builtin?.usedTools.has('TextToSpeech')
      if (shouldVoice) {
        synthesizeSpeech(text)
          .then(audioPath => ctx.replyWithVoice(new InputFile(audioPath)))
          .catch(err => logger.error({ err }, 'TTS failed'))
      }

      break // done — no more follow-ups
    }
  })
}

// --- Bot creation ---

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN не встановлений. Запусти `npm run setup` або додай в .env'
    )
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN)


  // Pre-middleware: handle stop/cancel immediately, bypass grammy's sequential processing
  bot.use(async (ctx, next) => {
    // AskUserQuestion answer callback
    if (ctx.callbackQuery?.data?.startsWith('ask:')) {
      const chatIdStr = String(ctx.chat?.id)
      const answer = ctx.callbackQuery.data.slice(4) // remove 'ask:'
      const pending = pendingQuestions.get(chatIdStr)
      if (pending) {
        clearTimeout(pending.timeout)
        pendingQuestions.delete(chatIdStr)
        pending.resolve(answer)
        await ctx.answerCallbackQuery({ text: `✓ ${answer}` })
        // Update message to show selected answer
        try {
          const msg = ctx.callbackQuery.message
          if (msg && 'text' in msg) {
            await ctx.editMessageText(`${msg.text}\n\n→ <b>${escapeHtml(answer)}</b>`, { parse_mode: 'HTML' })
          }
        } catch { /* ignore */ }
      } else {
        await ctx.answerCallbackQuery({ text: chatT(chatIdStr)('cb.questionExpired') })
      }
      return
    }
    // Permission request callback (ask mode)
    if (ctx.callbackQuery?.data?.startsWith('perm:')) {
      const chatIdStr = String(ctx.chat?.id)
      // Format: perm:allow:requestId or perm:deny:requestId
      const parts = ctx.callbackQuery.data.split(':')
      const action = parts[1]
      const requestId = parts.slice(2).join(':')
      const pending = pendingPermissions.get(requestId)
      if (pending) {
        clearTimeout(pending.timeout)
        pendingPermissions.delete(requestId)
        const allowed = action === 'allow'
        pending.resolve(allowed)
        await ctx.answerCallbackQuery({ text: allowed ? '✅' : '❌' })
        try {
          const msg = ctx.callbackQuery.message
          if (msg && 'text' in msg) {
            await ctx.editMessageText(`${msg.text}\n\n${allowed ? '✅ Дозволено' : '❌ Заборонено'}`, { parse_mode: 'HTML' })
          }
        } catch { /* ignore */ }
      } else {
        await ctx.answerCallbackQuery({ text: chatT(chatIdStr)('cb.questionExpired') })
      }
      return
    }
    // Admin stop callback
    if (ctx.callbackQuery?.data === 'admin:stop') {
      if (!isAuthorised(ctx.chat!.id)) return
      const { isAdminRunning, stopAdmin } = await import('./admin/on-demand.js')
      const status = isAdminRunning()
      const _t = chatT(String(ctx.chat!.id))
      if (!status.running) {
        await ctx.answerCallbackQuery({ text: _t('admin.notRunning') })
      } else {
        stopAdmin(true)
        await ctx.answerCallbackQuery({ text: _t('admin.stoppedShort') })
      }
      try {
        await ctx.editMessageText(_t('admin.stopped'))
      } catch {}
      return
    }
    // Stop button callback
    if (ctx.callbackQuery?.data?.startsWith('stop:')) {
      const targetChatId = ctx.callbackQuery.data.split(':')[1]
      if (String(ctx.chat?.id) === targetChatId) {
        const interrupted = await interruptRequest(targetChatId)
        const _t = chatT(targetChatId)
        await ctx.answerCallbackQuery({ text: interrupted ? _t('cb.stopping') : _t('cb.nothingToStop') })
      }
      return // don't pass to next middleware
    }
    // Voice confirm callback
    if (ctx.callbackQuery?.data?.startsWith('vc:')) {
      const chatIdStr = String(ctx.chat?.id)
      if (!isAuthorised(ctx.chat!.id)) return
      const action = ctx.callbackQuery.data.split(':')[1] // 'ok' or 'cancel'
      const pending = pendingVoiceConfirms.get(chatIdStr)
      const _t = chatT(chatIdStr)

      if (!pending) {
        await ctx.answerCallbackQuery({ text: _t('cb.voiceExpired') })
        return
      }

      clearTimeout(pending.timeout)
      pendingVoiceConfirms.delete(chatIdStr)

      if (action === 'ok') {
        await ctx.answerCallbackQuery({ text: '✅' })
        try {
          await ctx.editMessageText(`🎤 ${pending.transcript}\n\n${_t('voice.confirm.ok')}`)
        } catch {}
        // If agent is currently processing, inject as follow-up instead of new request
        if (isProcessing(chatIdStr)) {
          await addFollowup(chatIdStr, `[Voice transcribed]: ${pending.transcript}`)
        } else {
          await handleMessage(ctx, `[Voice transcribed]: ${pending.transcript}`, true)
        }
      } else {
        await ctx.answerCallbackQuery({ text: '❌' })
        try {
          await ctx.editMessageText(`<code>${pending.transcript}</code>\n\n${_t('voice.confirm.cancelled')}`, { parse_mode: 'HTML' })
        } catch {}
      }
      return
    }
    // Settings callback (delegated to bot-settings module)
    if (ctx.callbackQuery?.data?.startsWith('settings:')) {
      if (!isAuthorised(ctx.chat!.id)) return
      const chatIdStr = String(ctx.chat?.id)
      const key = ctx.callbackQuery.data.replace('settings:', '')
      await handleSettingsCallback(ctx, chatIdStr, key, clearPlanState)
      return
    }
    // Model selection callback (delegated to bot-settings module)
    if (ctx.callbackQuery?.data?.startsWith('model:')) {
      if (!isAuthorised(ctx.chat!.id)) return
      await handleModelCallback(ctx, String(ctx.chat?.id), ctx.callbackQuery.data.replace('model:', ''))
      return
    }
    // Session callbacks (delegated to bot-settings module)
    if (ctx.callbackQuery?.data?.startsWith('ses:')) {
      if (!isAuthorised(ctx.chat!.id)) return
      await handleSessionCallback(ctx, String(ctx.chat?.id), ctx.callbackQuery.data.slice(4))
      return
    }
    // Listener fact review callback (lr:approve:id, lr:decline:id, lr:skip)
    if (ctx.callbackQuery?.data?.startsWith('lr:')) {
      if (!isAuthorised(ctx.chat!.id)) {
        await ctx.answerCallbackQuery({ text: '⛔' })
        return
      }
      const { collectPendingFacts, reviewFact, getNextPendingFact, getFactById, getReviewStats } = await import('./listener-facts.js')
      const parts = ctx.callbackQuery.data.split(':')
      const action = parts[1] // approve | decline | skip
      const factId = parts.slice(2).join(':')

      const msg = ctx.callbackQuery.message
      const chatIdStr = String(ctx.chat?.id)
      const _t = chatT(chatIdStr)

      if (action === 'approve' && factId) {
        const { BOT_NAME: currentBot } = await import('./config.js')
        const item = reviewFact(factId, 'approved', currentBot)
        if (item) {
          // Insert into Facts DB
          const { insertFact } = await import('./db.js')
          const sector = item.type === 'fact' ? 'semantic' : 'episodic'
          const importance = item.type === 'task' ? 0.7 : item.type === 'decision' ? 0.6 : 0.5
          const rawTopic = item.topic || item.topics[0] || 'general'
          const { normalizeTopic } = await import('./listener-analyze.js')
          const topic = normalizeTopic(rawTopic)
          const tags = item.tags ? `${item.tags},${item.device},listener` : [...item.topics, item.device, 'listener'].join(',')
          const timePrefix = item.timestamp.replace(/T(\d{2})-(\d{2}).*/, ' $1:$2')
          const content = `[${timePrefix}] ${item.content}`
          const factId2 = insertFact(chatIdStr, content, topic, sector, tags, 'listener', importance)
          // Fire-and-forget: generate embedding
          Promise.all([import('./embeddings.js'), import('./db.js')]).then(async ([{ embed }, { updateFactEmbedding }]) => {
            const emb = await embed(content, 'passage')
            if (emb) updateFactEmbedding(factId2, emb)
          }).catch(() => {})
          // Notify: fact saved to memory
          try {
            await ctx.api.sendMessage(ctx.chat!.id,
              `🧠 <b>#${factId2}</b> [${sector}] <b>${topic}</b>\n${content}\n<i>${tags}</i>`,
              { parse_mode: 'HTML' }
            )
          } catch {}
        }
        await ctx.answerCallbackQuery({ text: '✅' })
        try {
          if (msg && 'text' in msg) {
            await ctx.editMessageText(`${msg.text}\n\n✅ <b>Збережено</b>`, { parse_mode: 'HTML' })
          }
        } catch {}
      } else if (action === 'decline' && factId) {
        reviewFact(factId, 'declined')
        await ctx.answerCallbackQuery({ text: '❌' })
        try {
          if (msg && 'text' in msg) {
            await ctx.editMessageText(`${msg.text}\n\n❌ <b>Пропущено</b>`, { parse_mode: 'HTML' })
          }
        } catch {}
      } else if (action === 'skip') {
        await ctx.answerCallbackQuery()
      }

      // Send next pending fact
      collectPendingFacts()
      const next = getNextPendingFact()
      if (next) {
        await sendListenerFactForReview(ctx, next)
      } else {
        const stats = getReviewStats()
        if (stats.approved > 0 || stats.declined > 0) {
          await ctx.api.sendMessage(ctx.chat!.id, `✅ Всі факти переглянуто!\n\n📊 +${stats.approved} збережено, ${stats.declined} пропущено`)
        }
      }
      return
    }

    // Group approval callback
    if (ctx.callbackQuery?.data?.startsWith('grp:')) {
      const ownerChatId = ALLOWED_CHAT_ID.split(',')[0]?.trim()
      if (String(ctx.chat?.id) !== ownerChatId) {
        await ctx.answerCallbackQuery({ text: '⛔ Тільки власник' })
        return
      }
      const parts = ctx.callbackQuery.data.split(':')
      const action = parts[1]
      const groupId = parts.slice(2).join(':')

      const pending = pendingGroupApprovals.get(groupId)

      if (action === 'allow') {
        addApprovedGroup(groupId)
        refreshApprovedGroups()
        if (pending) {
          clearTimeout(pending.timeout)
          pendingGroupApprovals.delete(groupId)
        }
        await ctx.answerCallbackQuery({ text: '✅ Групу додано' })
        try {
          const msg = ctx.callbackQuery.message
          if (msg && 'text' in msg) {
            await ctx.editMessageText(`${msg.text}\n\n✅ <b>Дозволено</b>`, { parse_mode: 'HTML' })
          }
        } catch {}
      } else if (action === 'deny') {
        if (pending) {
          clearTimeout(pending.timeout)
          pendingGroupApprovals.delete(groupId)
        }
        try { await bot.api.leaveChat(Number(groupId)) } catch {}
        await ctx.answerCallbackQuery({ text: '❌ Відхилено, бот вийшов' })
        try {
          const msg = ctx.callbackQuery.message
          if (msg && 'text' in msg) {
            await ctx.editMessageText(`${msg.text}\n\n❌ <b>Відхилено</b>`, { parse_mode: 'HTML' })
          }
        } catch {}
      }
      return
    }
    // /cancel command
    if (ctx.message?.text === '/cancel') {
      const chatIdStr = String(ctx.chat?.id)
      if (!isAuthorised(ctx.chat!.id)) return
      const _t = chatT(chatIdStr)
      const cancelled = await cancelRequest(chatIdStr)
      const cleared = clearQueue(chatIdStr)
      if (cancelled || cleared > 0) {
        const parts: string[] = []
        if (cancelled) parts.push(_t('cancel.request'))
        if (cleared > 0) parts.push(_t('cancel.queue', { n: cleared }))
        await ctx.reply(parts.join(', '))
      } else {
        await ctx.reply(_t('cancel.nothing'))
      }
      return
    }
    // Follow-up: if agent is running and user sends a message,
    // inject it — agent gets soft-interrupted and resumes with the follow-up in same session
    if (ctx.message && !ctx.message.text?.startsWith('/')) {
      const chatIdStr = String(ctx.chat?.id)
      if (isProcessing(chatIdStr)) {
        // Voice + voice_confirm ON: let it through to voice handler for transcription & confirm UI
        if (ctx.message.voice && getChatSetting(chatIdStr, 'voice_confirm') === '1') {
          await next()
          return
        }
        // Build follow-up text from any message type
        let followupText = ctx.message.text ?? ''
        if (!followupText && ctx.message.caption) followupText = ctx.message.caption
        if (!followupText && ctx.message.voice) followupText = '[Voice message received]'
        if (!followupText && ctx.message.photo) followupText = '[Photo received]'
        if (!followupText && ctx.message.document) followupText = `[Document: ${ctx.message.document.file_name ?? 'file'}]`
        if (followupText) {
          await addFollowup(chatIdStr, followupText)
          // Visual feedback: react with 👀 so user knows it was captured
          await ctx.react('👀').catch(() => {})
        }
        return
      }
    }
    await next()
  })

  // --- Listener fact review helper ---
  async function sendListenerFactForReview(ctx: Context, item: import('./listener-facts.js').FactReviewItem) {
    const chatId = ctx.chat?.id
    if (!chatId) return
    const typeEmoji = item.type === 'fact' ? '💡' : item.type === 'decision' ? '✅' : '📌'
    const typeLabel = item.type === 'fact' ? 'Факт' : item.type === 'decision' ? 'Рішення' : 'Задача'
    const time = item.timestamp.replace(/T(\d{2})-(\d{2}).*/, '$1:$2')
    const topicsStr = item.topics.length > 0 ? `\n🏷 ${item.topics.join(', ')}` : ''

    const text = [
      `${typeEmoji} <b>${typeLabel} із запису</b>`,
      `📅 ${item.date} ${time} · 🔊 ${item.device}${topicsStr}`,
      '',
      item.content,
    ].join('\n')

    await ctx.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Зберегти', callback_data: `lr:approve:${item.id}` },
          { text: '❌ Пропустити', callback_data: `lr:decline:${item.id}` },
          { text: '⏭ Потім', callback_data: 'lr:skip' },
        ]],
      },
    })
  }

  // /review — Tinder-style fact review from room listener
  bot.command('review', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const { collectPendingFacts, getNextPendingFact, getReviewStats } = await import('./listener-facts.js')
    const added = collectPendingFacts()
    const stats = getReviewStats()
    const next = getNextPendingFact()
    if (!next) {
      await ctx.reply(`📋 Немає фактів для перегляду.\n\n📊 Всього: ${stats.approved} збережено, ${stats.declined} пропущено`)
      return
    }
    if (added > 0) {
      await ctx.reply(`📋 Знайдено ${stats.pending} нових фактів із записів. Починаємо перегляд:`)
    }
    await sendListenerFactForReview(ctx, next)
  })

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id
    const t = chatT(String(chatId))
    await ctx.reply(t('cmd.start', { chatId }), { parse_mode: 'HTML' })
  })

  bot.command('chatid', async (ctx) => {
    const t = chatT(String(ctx.chat.id))
    await ctx.reply(t('cmd.chatid', { chatId: ctx.chat.id }), { parse_mode: 'HTML' })
  })

  // /cancel handled in pre-middleware above

  // --- /new (session clear) + aliases ---
  const clearSessionHandler = async (ctx: Context) => {
    const chatIdStr = String(ctx.chat!.id)
    const oldSessionId = getSession(chatIdStr)
    clearSession(chatIdStr)
    logAudit(chatIdStr, 'session_clear')
    // Fire-and-forget: consolidate previous session in background
    if (oldSessionId) {
      import('./consolidate.js').then(({ consolidateSession }) =>
        consolidateSession(oldSessionId, chatIdStr, BOT_DIR)
          .catch(err => logger.warn({ err, oldSessionId }, 'Session consolidation on /new failed'))
      )
    }
    await ctx.reply(chatT(chatIdStr)('cmd.newchat'))
  }
  bot.command('new', clearSessionHandler)
  bot.command('newchat', clearSessionHandler)
  bot.command('forget', clearSessionHandler)

  bot.command('usage', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const t = chatT(String(ctx.chat.id))
    const now = Math.floor(Date.now() / 1000)
    const weekAgo = now - 7 * 24 * 60 * 60
    const dayAgo = now - 24 * 60 * 60
    const hourAgo = now - 60 * 60

    const week = getUsageSince(weekAgo)
    const day = getUsageSince(dayAgo)
    const hour = getUsageSince(hourAgo)

    const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
    const usd = (n: number) => `$${n.toFixed(4)}`

    const lines = [
      t('cmd.usage.title'),
      '',
      t('cmd.usage.hour', { requests: hour.requests, tokens: k(hour.inputTokens + hour.outputTokens), cost: usd(hour.costUSD) }),
      t('cmd.usage.day', { requests: day.requests, tokens: k(day.inputTokens + day.outputTokens), cost: usd(day.costUSD) }),
      t('cmd.usage.week', { requests: week.requests, tokens: k(week.inputTokens + week.outputTokens), cost: usd(week.costUSD) }),
      '',
      `${t('cmd.usage.details')}`,
      `  in: ${k(week.inputTokens)} | out: ${k(week.outputTokens)}`,
      `  cache read: ${k(week.cacheReadTokens)} | cache new: ${k(week.cacheCreationTokens)}`,
    ]
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })

  // Register /settings, /model, /session and aliases (delegated to bot-settings module)
  registerSettingsCommands(bot, isAuthorised)

  bot.command('admin', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const t = chatT(String(ctx.chat.id))

    const { isAdminRunning, startAdmin } = await import('./admin/on-demand.js')

    const status = isAdminRunning()
    if (status.running) {
      const url = `${status.url}/?token=${status.token}`
      await ctx.reply(
        t('admin.running'),
        { reply_markup: { inline_keyboard: [
          [{ text: t('admin.open'), url }],
          [{ text: t('admin.stop'), callback_data: 'admin:stop' }],
        ] } }
      )
      return
    }

    const port = parseInt(process.env.ADMIN_PORT || '3000', 10)
    const chatId = ctx.chat.id

    const { url } = startAdmin(port, BOT_NAME, () => {
      ctx.api.sendMessage(chatId, t('admin.idle')).catch(() => {})
    })

    await ctx.reply(
      t('admin.started'),
      {
        reply_markup: { inline_keyboard: [
          [{ text: t('admin.open'), url }],
          [{ text: t('admin.stop'), callback_data: 'admin:stop' }],
        ] },
      }
    )
  })

  // /restart — restart bot process (watchdog will auto-restart)
  bot.command('restart', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    await ctx.reply('🔄 Restarting in 5s...')
    setTimeout(() => process.exit(42), 5000)
  })

  // /update — git pull, rebuild, restart
  bot.command('update', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const { exec } = await import('child_process')
    const run = (cmd: string): Promise<string> =>
      new Promise((resolve, reject) => {
        exec(cmd, { cwd: process.cwd(), timeout: 120000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message))
          else resolve(stdout.trim())
        })
      })

    const msg = await ctx.reply('🔄 Updating...\n\n`git pull`...', { parse_mode: 'Markdown' })
    try {
      const pullResult = await run('git pull')
      if (pullResult.includes('Already up to date')) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, '✅ Already up to date.')
        return
      }

      await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `🔄 Updating...\n\n\`git pull\` ✓\n\`npm run build\`...`, { parse_mode: 'Markdown' })
      await run('npm run build')

      await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `✅ Updated!\n\n\`\`\`\n${pullResult}\n\`\`\`\n\nRestarting...`, { parse_mode: 'Markdown' })
      setTimeout(() => process.exit(42), 1000)
    } catch (err: any) {
      await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Update failed:\n\n\`\`\`\n${err.message}\n\`\`\``, { parse_mode: 'Markdown' })
    }
  })

  // /stop — reset group iteration counter
  bot.command('stop', async (ctx) => {
    const chatId = ctx.chat.id
    if (!isGroupChat(ctx)) return
    if (!isAuthorised(chatId)) return
    // Only authorised users can stop
    const sender = ctx.message?.from
    if (!sender || sender.is_bot || !isAuthorised(sender.id)) return
    const chatIdStr = String(chatId)
    const state = getGroupState(chatIdStr)
    resetGroupIterations(chatIdStr)
    resetDebateState(chatIdStr)
    relayClear(chatIdStr)
    clearGroupContext(chatIdStr)
    stoppedChats.add(chatIdStr)
    await ctx.reply(`⏹ Діалог зупинено${state ? ` (було ${state.count} ітерацій)` : ''}.`)
  })

  // /pause — temporarily pause group debate (resume with /resume or any human message)
  bot.command('pause', async (ctx) => {
    const chatId = ctx.chat.id
    if (!isGroupChat(ctx)) return
    if (!isAuthorised(chatId)) return
    const sender = ctx.message?.from
    if (!sender || sender.is_bot || !isAuthorised(sender.id)) return
    const chatIdStr = String(chatId)
    pausedChats.add(chatIdStr)
    debateLog(chatIdStr, 'PAUSED')
    await ctx.reply('⏸ Діалог на паузі. /resume або нове повідомлення щоб продовжити.')
  })

  // /resume — resume paused group debate
  bot.command('resume', async (ctx) => {
    const chatId = ctx.chat.id
    if (!isGroupChat(ctx)) return
    if (!isAuthorised(chatId)) return
    const sender = ctx.message?.from
    if (!sender || sender.is_bot || !isAuthorised(sender.id)) return
    const chatIdStr = String(chatId)
    if (pausedChats.has(chatIdStr)) {
      pausedChats.delete(chatIdStr)
      debateLog(chatIdStr, 'RESUMED')
      await ctx.reply('▶️ Діалог відновлено.')
      // Write resume signal to relay so paused bots pick up
      try {
        relayWrite(chatIdStr, ctx.me?.username ?? BOT_NAME, '[System: debate resumed — continue from where you left off]')
        debateLog(chatIdStr, 'RESUME_RELAY_WRITTEN')
      } catch { /* ignore */ }
    } else if (stoppedChats.has(chatIdStr)) {
      await ctx.reply('⏹ Діалог був зупинений через /stop. Надішли нове повідомлення для нового діалогу.')
    } else {
      await ctx.reply('▶️ Діалог не на паузі.')
    }
  })

  // Group membership: bot added/removed from a group
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember
    const chat = update.chat
    const newStatus = update.new_chat_member.status
    const oldStatus = update.old_chat_member.status

    // Bot added to group
    if ((chat.type === 'group' || chat.type === 'supergroup') &&
        (newStatus === 'member' || newStatus === 'administrator') &&
        (oldStatus === 'left' || oldStatus === 'kicked')) {

      const chatIdStr = String(chat.id)
      const ownerChatId = ALLOWED_CHAT_ID.split(',')[0]?.trim()
      if (!ownerChatId) return

      // Already approved?
      if (isAuthorised(chat.id)) return

      const chatTitle = 'title' in chat ? chat.title : chatIdStr
      logger.info({ chatId: chatIdStr, title: chatTitle }, 'Bot added to new group, requesting owner approval')

      // Clear previous pending for same group
      const prev = pendingGroupApprovals.get(chatIdStr)
      if (prev) clearTimeout(prev.timeout)

      // Auto-deny after 24h
      const timeout = setTimeout(() => {
        pendingGroupApprovals.delete(chatIdStr)
        bot.api.leaveChat(chat.id).catch(() => {})
      }, 24 * 60 * 60 * 1000)

      pendingGroupApprovals.set(chatIdStr, { chatId: chat.id, chatTitle, timeout })

      await bot.api.sendMessage(Number(ownerChatId),
        `🆕 Бота додано до групи:\n\n<b>${escapeHtml(chatTitle)}</b>\n<code>${chatIdStr}</code>\n\nДозволити читати та реагувати в цій групі?`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Дозволити', callback_data: `grp:allow:${chatIdStr}` },
              { text: '❌ Відхилити', callback_data: `grp:deny:${chatIdStr}` },
            ]],
          },
        }
      ).catch(err => logger.error({ err, chatId: chatIdStr }, 'Failed to send group approval request'))
    }

    // Bot removed from group
    if ((chat.type === 'group' || chat.type === 'supergroup') &&
        (newStatus === 'left' || newStatus === 'kicked') &&
        (oldStatus === 'member' || oldStatus === 'administrator')) {

      const chatIdStr = String(chat.id)

      // Clean up approved group
      if (loadApprovedGroups().has(chatIdStr)) {
        removeApprovedGroup(chatIdStr)
        refreshApprovedGroups()

        const ownerChatId = ALLOWED_CHAT_ID.split(',')[0]?.trim()
        if (ownerChatId) {
          const chatTitle = 'title' in chat ? chat.title : chatIdStr
          await bot.api.sendMessage(Number(ownerChatId),
            `🚪 Бота видалено з групи <b>${escapeHtml(chatTitle)}</b> (<code>${chatIdStr}</code>)`,
            { parse_mode: 'HTML' }
          ).catch(() => {})
        }
      }

      // Clean up pending approval
      const pending = pendingGroupApprovals.get(chatIdStr)
      if (pending) {
        clearTimeout(pending.timeout)
        pendingGroupApprovals.delete(chatIdStr)
      }
    }
  })

  // Text messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    const chatIdStr = String(ctx.chat.id)


    // skip known bot commands (they have their own handlers above)
    if (/^\/(start|chatid|new|newchat|forget|memory|voice|usage|stats|model|cancel|delay|style|show_team_work|admin|lang|settings|session|stop|pause|resume|restart|update)\b/.test(text)) return

    // Strip leading / from unknown commands so SDK doesn't interpret as slash command
    const cleanText = text.startsWith('/') ? text.slice(1) : text
    if (text.startsWith('/')) {
      logAudit(chatIdStr, 'command', text.split(' ')[0])
    }
    await handleMessage(ctx, cleanText)
  })

  // Voice messages
  bot.on('message:voice', async (ctx) => {
    const chatId = ctx.chat.id
    if (isGroupChat(ctx)) {
      if (!isAuthorised(chatId) || !shouldProcessGroupMessage(ctx)) return
    } else if (!isAuthorised(chatId)) return

    const t = chatT(String(chatId))
    const caps = voiceCapabilities()
    if (!caps.stt) {
      await ctx.reply(t('cmd.voice.noStt'))
      return
    }

    try {
      const file = await ctx.getFile()
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, file.file_id, 'voice.oga')
      const transcript = await transcribeAudio(localPath)

      // Voice confirm mode: show transcript with confirm/cancel buttons
      if (getChatSetting(String(chatId), 'voice_confirm') === '1') {
        // Cancel any previous pending voice confirm for this chat
        const prevPending = pendingVoiceConfirms.get(String(chatId))
        if (prevPending) {
          clearTimeout(prevPending.timeout)
          pendingVoiceConfirms.delete(String(chatId))
          try {
            await bot.api.editMessageText(chatId, prevPending.messageId, `<code>${prevPending.transcript}</code>\n\n⏱`, { parse_mode: 'HTML' })
          } catch {}
        }

        const confirmMsg = await ctx.reply(
          `${t('voice.confirm.prompt')}\n\n${transcript}`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: t('voice.confirm.btn.ok'), callback_data: `vc:ok:${chatId}` },
                { text: t('voice.confirm.btn.cancel'), callback_data: `vc:cancel:${chatId}` },
              ]]
            }
          }
        )

        const msgId = confirmMsg.message_id
        const timeout = setTimeout(() => {
          const current = pendingVoiceConfirms.get(String(chatId))
          if (current?.messageId !== msgId) return
          pendingVoiceConfirms.delete(String(chatId))
          bot.api.editMessageText(chatId, msgId, `<code>${transcript}</code>\n\n⏱ ${t('cb.voiceExpired')}`, { parse_mode: 'HTML' })
            .catch(() => {})
        }, 120_000)

        pendingVoiceConfirms.set(String(chatId), {
          transcript,
          messageId: confirmMsg.message_id,
          timeout,
        })
      } else {
        // Default: send directly
        await ctx.reply(`[voice]: ${transcript}`)
        await handleMessage(ctx, `[Voice transcribed]: ${transcript}`, true)
      }
    } catch (err) {
      logger.error({ err }, 'Voice processing failed')
      await ctx.reply(t('cmd.voice.fail'))
    }
  })

  // Photos
  bot.on('message:photo', async (ctx) => {
    const chatId = ctx.chat.id
    if (isGroupChat(ctx)) {
      if (!isAuthorised(chatId) || !shouldProcessGroupMessage(ctx)) return
    } else if (!isAuthorised(chatId)) return

    try {
      const photos = ctx.message.photo
      const largest = photos[photos.length - 1]
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, largest.file_id, 'photo.jpg')
      const caption = ctx.message.caption ?? ''

      // If caption starts with /edit -- use Nano Banana 2 for editing
      if (caption.startsWith('/edit')) {
        const t = chatT(String(chatId))
        const editPrompt = caption.replace(/^\/edit\s*/, '').trim()
        if (!editPrompt) {
          await ctx.reply(t('cmd.edit.usage'))
          return
        }
        await ctx.api.sendChatAction(chatId, 'upload_photo').catch(() => {})
        try {
          const result = await editImage(localPath, editPrompt)
          if (result.imagePath) {
            await ctx.replyWithPhoto(new InputFile(result.imagePath), {
              caption: result.text?.slice(0, 1024) ?? undefined,
            })
          } else {
            await ctx.reply(result.text ?? t('cmd.edit.fail'))
          }
        } catch (err) {
          logger.error({ err }, 'Image editing failed')
          await ctx.reply(t('cmd.edit.error', { err: err instanceof Error ? err.message : String(err) }))
        }
        return
      }

      // Default: pass to Claude
      const message = buildPhotoMessage(localPath, caption)
      await handleMessage(ctx, message)
    } catch (err) {
      logger.error({ err }, 'Photo processing failed')
      await ctx.reply(chatT(String(chatId))('media.photoFail'))
    }
  })

  // Documents
  bot.on('message:document', async (ctx) => {
    const chatId = ctx.chat.id
    if (isGroupChat(ctx)) {
      if (!isAuthorised(chatId) || !shouldProcessGroupMessage(ctx)) return
    } else if (!isAuthorised(chatId)) return

    try {
      const doc = ctx.message.document
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, doc.file_id, doc.file_name)
      const message = buildDocumentMessage(localPath, doc.file_name ?? 'document', ctx.message.caption)
      await handleMessage(ctx, message)
    } catch (err) {
      logger.error({ err }, 'Document processing failed')
      await ctx.reply(chatT(String(chatId))('media.docFail'))
    }
  })

  // Videos
  bot.on('message:video', async (ctx) => {
    const chatId = ctx.chat.id
    if (isGroupChat(ctx)) {
      if (!isAuthorised(chatId) || !shouldProcessGroupMessage(ctx)) return
    } else if (!isAuthorised(chatId)) return

    try {
      const video = ctx.message.video
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, video.file_id, 'video.mp4')
      const message = buildVideoMessage(localPath, ctx.message.caption)
      await handleMessage(ctx, message)
    } catch (err) {
      logger.error({ err }, 'Video processing failed')
      await ctx.reply(chatT(String(chatId))('media.videoFail'))
    }
  })

  // WebApp data (Mini App sends data back via Telegram.WebApp.sendData)
  bot.on('message:web_app_data', async (ctx) => {
    const chatId = ctx.chat.id
    if (!isAuthorised(chatId)) return

    const data = ctx.message.web_app_data.data
    await handleMessage(ctx, `[WebApp data received]: ${data}`)
  })

  // Poll answer handler (for AskUser poll mode)
  bot.on('poll_answer', async (ctx) => {
    const pollAnswer = ctx.pollAnswer
    const pollId = pollAnswer.poll_id
    const pending = pendingPolls.get(pollId)
    if (!pending) return

    const optionIds = pollAnswer.option_ids

    // Ignore retracted votes (empty option_ids)
    if (optionIds.length === 0) return

    // Resolve with selected option labels
    clearTimeout(pending.timeout)
    pendingPolls.delete(pollId)

    const selectedLabels = optionIds.map(i => pending.options[i]).filter(Boolean)
    const answer = selectedLabels.join(', ')

    // Close the poll to show it's done
    ctx.api.stopPoll(pending.chatId, pending.messageId).catch(() => {})

    pending.resolve(answer)
  })

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Bot error')
  })

  // Register commands menu in Telegram (both languages)
  const tUk = createBotT('uk')
  const tEn = createBotT('en')
  const cmds = (t: BotT) => [
    { command: 'new', description: t('menu.new') },
    { command: 'cancel', description: t('menu.cancel') },
    { command: 'model', description: t('menu.model') },
    { command: 'usage', description: t('menu.usage') },
    { command: 'settings', description: t('menu.settings') },
    { command: 'session', description: t('menu.session') },
    { command: 'admin', description: t('menu.admin') },
    { command: 'restart', description: t('menu.restart') },
    { command: 'update', description: t('menu.update') },
    { command: 'review', description: t('menu.review') },
  ]
  // Default commands in Ukrainian
  bot.api.setMyCommands(cmds(tUk)).catch(err => logger.error({ err }, 'Failed to set bot commands'))
  // English commands for en language
  bot.api.setMyCommands(cmds(tEn), { language_code: 'en' }).catch(err => logger.error({ err }, 'Failed to set EN bot commands'))

  return bot
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  const bot = new Bot(TELEGRAM_BOT_TOKEN)
  const formatted = formatForTelegram(text)
  const chunks = splitMessage(formatted)
  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(Number(chatId), chunk, { parse_mode: 'HTML' })
    } catch {
      await bot.api.sendMessage(Number(chatId), chunk.replace(/<[^>]+>/g, ''))
    }
  }
}

/**
 * Start relay listener for bot-to-bot communication in group chats.
 * Polls relay files for messages from other bots and processes them.
 */
export function startRelayListener(bot: Bot): () => void {
  if (!ALLOWED_CHAT_ID) return () => {}

  // Dynamic group IDs: env + approved groups from DB
  const getGroupChatIds = (): string[] => {
    const envIds = ALLOWED_CHAT_ID.split(',').map(s => s.trim()).filter(id => id.startsWith('-'))
    const dynamicIds = getApprovedGroups().filter(id => id.startsWith('-'))
    return [...new Set([...envIds, ...dynamicIds])]
  }

  const initial = getGroupChatIds()
  if (initial.length === 0) {
    logger.debug('No group chats configured — relay listener not started')
    // Still start with dynamic function so new groups get picked up
  }

  return startRelayPoller(getGroupChatIds, (msg) => {
    // Build group prefix from relay data
    const prefix = `[Group message from ${msg.botName} @${msg.botUsername} [bot]]\n`
    const fullText = prefix + msg.text

    // Create a minimal context-like object for handleMessage
    // We need: chat.id, api (for sending), me (for bot info)
    const fakeCtx = {
      chat: { id: Number(msg.chatId), type: 'group' as const },
      message: undefined,
      callbackQuery: undefined,
      api: bot.api,
      me: bot.botInfo,
      reply: (text: string, opts?: any) => bot.api.sendMessage(Number(msg.chatId), text, opts),
      replyWithVoice: (input: any) => bot.api.sendVoice(Number(msg.chatId), input),
    } as unknown as Context

    handleMessage(fakeCtx, fullText, false, true).catch((err) => {
      logger.error({ err, chatId: msg.chatId, from: msg.botName }, 'Relay message processing failed')
    })
  })
}
