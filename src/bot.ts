import { Bot, Context, InputFile } from 'grammy'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
  TELEGRAPH_ENABLED,
  BOT_NAME,
  BOT_DIR,
} from './config.js'
import { getSession, setSession, clearSession, getAllMemories, logUsage, getUsageSince, getChatSetting, setChatSetting, deleteChatSetting, logAudit } from './db.js'
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
import { getModel, setModel, MODELS, getModelLabel } from './model.js'
import { chatT, getChatLang, setChatLang, createBotT, type BotLang, type BotT } from './bot-i18n.js'
import { createBuiltinMcpServer } from './builtin-tools.js'
import { listDiskSessions, listDiskSessionsByKey, listClaudeProjects, getSessionDetail, type DiskSession, type ClaudeProject } from './disk-sessions.js'
import { hasSessionTitle } from './session-titles.js'
import { classifyReaction } from './auto-react.js'
import { appendFileSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'

// --- AskUser pending responses ---
const pendingQuestions = new Map<string, {
  resolve: (answer: string) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}>()

const pendingReplyKeyboard = new Map<string, {
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

// --- Formatting ---

export function formatForTelegram(text: string): string {
  // Extract and protect code blocks
  const codeBlocks: string[] = []
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.trimEnd())
    const idx = codeBlocks.length
    codeBlocks.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${escaped}</code></pre>`)
    return `%%CODEBLOCK_${idx}%%`
  })

  // Protect inline code
  const inlineCodes: string[] = []
  processed = processed.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `%%INLINE_${idx}%%`
  })

  // Convert markdown tables to readable list format
  processed = processed.replace(
    /((?:^\|.+\|[ \t]*\n){2,})/gm,
    (tableBlock) => {
      const rows = tableBlock.trim().split('\n').map(row =>
        row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
      )
      // Skip separator rows (---|---)
      const dataRows = rows.filter(row => !row.every(cell => /^[-:\s]+$/.test(cell)))
      if (dataRows.length < 2) return tableBlock

      const headers = dataRows[0]
      const body = dataRows.slice(1)
      return body.map(row =>
        row.map((cell, i) => {
          const header = headers[i]
          if (!cell) return ''
          return header ? `**${header}:** ${cell}` : cell
        }).filter(Boolean).join('\n')
      ).join('\n\n') + '\n'
    }
  )

  // Escape HTML in remaining text
  processed = escapeHtml(processed)

  // Restore code placeholders (already escaped inside)
  processed = processed.replace(/%%CODEBLOCK_(\d+)%%/g, (_, i) => codeBlocks[Number(i)])
  processed = processed.replace(/%%INLINE_(\d+)%%/g, (_, i) => inlineCodes[Number(i)])

  // Headings → bold
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  processed = processed.replace(/__(.+?)__/g, '<b>$1</b>')

  // Italic: *text* or _text_ (not inside words)
  processed = processed.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>')
  processed = processed.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>')

  // Strikethrough
  processed = processed.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links: [text](url)
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Checkboxes
  processed = processed.replace(/^- \[ \]/gm, '☐')
  processed = processed.replace(/^- \[x\]/gm, '☑')

  // Strip horizontal rules
  processed = processed.replace(/^[-*_]{3,}$/gm, '')

  return processed.trim()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Smart message splitter that respects HTML code blocks (<pre>).
 * Tracks open/close state and re-opens code blocks in continuation chunks.
 */
export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text
  let inPre = false

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      if (inPre) remaining += '</code></pre>'
      chunks.push(remaining)
      break
    }

    let chunk = remaining.substring(0, limit)
    let splitIndex = limit

    // Track <pre> state in this chunk
    let tempInPre = inPre
    const preOpenRegex = /<pre><code[^>]*>/g
    const preCloseRegex = /<\/code><\/pre>/g
    let match: RegExpExecArray | null

    // Count opens
    while ((match = preOpenRegex.exec(chunk)) !== null) {
      tempInPre = true
    }
    // Count closes
    while ((match = preCloseRegex.exec(chunk)) !== null) {
      tempInPre = false
    }

    if (!tempInPre) {
      // Not in a code block: split at natural boundaries
      const paragraphBreak = chunk.lastIndexOf('\n\n')
      if (paragraphBreak > limit / 2) {
        splitIndex = paragraphBreak + 2
      } else {
        const newlineBreak = chunk.lastIndexOf('\n')
        if (newlineBreak > limit / 2) {
          splitIndex = newlineBreak + 1
        } else {
          const spaceBreak = chunk.lastIndexOf(' ')
          if (spaceBreak > limit / 2) {
            splitIndex = spaceBreak + 1
          }
        }
      }
    } else {
      // In a code block: try to split at a newline
      const newlineSplit = chunk.lastIndexOf('\n')
      if (newlineSplit > limit / 2) {
        splitIndex = newlineSplit + 1
      }
    }

    chunk = remaining.substring(0, splitIndex)

    // Recount <pre> state in the adjusted chunk
    tempInPre = inPre
    const adjustedOpenRegex = /<pre><code[^>]*>/g
    const adjustedCloseRegex = /<\/code><\/pre>/g
    while ((match = adjustedOpenRegex.exec(chunk)) !== null) tempInPre = true
    while ((match = adjustedCloseRegex.exec(chunk)) !== null) tempInPre = false

    // If ending inside a code block, close it
    if (tempInPre) {
      chunk = chunk.trimEnd() + '</code></pre>'
      inPre = true
    } else {
      inPre = false
    }

    chunks.push(chunk)
    remaining = remaining.substring(splitIndex).trimStart()

    // If we were in a code block, reopen it
    if (inPre && remaining.length > 0) {
      remaining = '<pre><code>' + remaining
    }
  }

  // Add part indicators
  if (chunks.length > 1) {
    return chunks.map((part, i) => {
      const indicator = `\n\n<i>[${i + 1}/${chunks.length}]</i>`
      if (part.length + indicator.length <= limit) {
        return part + indicator
      }
      return part
    })
  }

  return chunks
}

// --- Usage stats ---

function formatUsageStats(u: UsageStats): string {
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  const cost = u.costUSD >= 0.01 ? `$${u.costUSD.toFixed(2)}` : `$${u.costUSD.toFixed(4)}`
  const contextPct = u.contextWindow > 0
    ? ((u.lastTurnContextTokens / u.contextWindow) * 100).toFixed(0)
    : '?'

  return `<i>${cost} | ctx: ${contextPct}% (${k(u.lastTurnContextTokens)}/${k(u.contextWindow)}) | in: ${k(u.inputTokens)} out: ${k(u.outputTokens)}</i>`
}

// --- Send chunked ---

async function sendChunked(ctx: Context, text: string): Promise<void> {
  const formatted = formatForTelegram(text)
  const chunks = splitMessage(formatted)
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: 'HTML' })
    } catch {
      await ctx.reply(chunk.replace(/<[^>]+>/g, ''))
    }
  }
}

// --- Auth ---

function isAuthorised(chatId: number): boolean {
  if (!ALLOWED_CHAT_ID) return true // first-run mode
  const allowed = ALLOWED_CHAT_ID.split(',').map(s => s.trim())
  return allowed.includes(String(chatId))
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

// --- Group chunk protocol (sending side) ---
// Multi-chunk messages get emoji ID + ⏩ continuation marker.
// Receiving bot assembles chunks by matching emoji ID.

const CHUNK_EMOJIS = ['🔴', '🟢', '🔵', '🟡', '🟣', '🟠', '🔶', '🔷', '🟤', '⚫']

function randomChunkEmoji(): string {
  return CHUNK_EMOJIS[Math.floor(Math.random() * CHUNK_EMOJIS.length)]
}

/** Send response in group mode with chunk assembly markers.
 *  Auto-prepends @partnerUsername if debate is active (so the other bot receives the message).
 *  Single message: sent as-is (no markers).
 *  Multiple chunks: each gets [N/M] emoji⏩, last gets [N/M] emoji (no ⏩). */
async function sendGroupChunked(ctx: Context, text: string): Promise<void> {
  // Auto-prepend @mention for debate partner
  const chatIdStr = String(ctx.chat?.id)
  const debate = getDebateState(chatIdStr)
  if (debate) {
    // Strip any existing @mention of partner at the start (agent might still add it)
    const partnerMentionRe = new RegExp(`^\\s*(?:(?:Питання|Відповідь)\\s+для\\s+)?@${debate.partnerUsername}[:\\s]*`, 'i')
    text = text.replace(partnerMentionRe, '').trimStart()
    // Prepend clean @mention
    text = `@${debate.partnerUsername}\n${text}`
    debateLog(chatIdStr, 'SEND_WITH_MENTION', { partner: debate.partnerUsername, textPreview: text.slice(0, 100) })
  } else {
    debateLog(chatIdStr, 'SEND_NO_DEBATE_STATE', { textPreview: text.slice(0, 100) })
  }
  const formatted = formatForTelegram(text)
  const chunks = splitMessage(formatted)

  if (chunks.length === 1) {
    // Single chunk: send as-is, no markers
    try {
      await ctx.reply(chunks[0], { parse_mode: 'HTML' })
    } catch {
      await ctx.reply(chunks[0].replace(/<[^>]+>/g, ''))
    }
    return
  }

  // Multi-chunk: add emoji ID + continuation markers
  const emoji = randomChunkEmoji()
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    // splitMessage already adds [N/M] indicator — append emoji marker after it
    const marker = isLast ? ` ${emoji}` : ` ${emoji}⏩`
    let chunk = chunks[i] + marker
    try {
      await ctx.reply(chunk, { parse_mode: 'HTML' })
    } catch {
      await ctx.reply(chunk.replace(/<[^>]+>/g, ''))
    }
  }
}

// --- Group chunk protocol (receiving side) ---
// Buffer incoming chunks from other bots, assemble when complete.

const CHUNK_CONTINUE_RE = /\s([🔴🟢🔵🟡🟣🟠🔶🔷🟤⚫])⏩$/
const CHUNK_FINAL_RE = /\s([🔴🟢🔵🟡🟣🟠🔶🔷🟤⚫])$/
const CHUNK_BUFFER_TIMEOUT_MS = 30_000

interface ChunkBuffer {
  chunks: string[]
  emoji: string
  firstCtx: Context
  timer: ReturnType<typeof setTimeout>
}

const groupChunkBuffer = new Map<string, ChunkBuffer>()

/** Strip chunk marker from message text */
function stripChunkMarker(text: string): string {
  return text.replace(/\s[🔴🟢🔵🟡🟣🟠🔶🔷🟤⚫]⏩?$/, '').trimEnd()
}

/**
 * Try to handle a group message as a chunk.
 * Returns true if message was consumed (buffered or assembled), false if not a chunk.
 */
function handleGroupChunk(ctx: Context, text: string): boolean {
  if (!isGroupChat(ctx)) return false
  const sender = ctx.message?.from
  if (!sender?.is_bot) return false

  const groupId = String(ctx.chat!.id)
  const senderId = sender.id

  // Check for continuation marker: emoji⏩
  const continueMatch = text.match(CHUNK_CONTINUE_RE)
  if (continueMatch) {
    const emoji = continueMatch[1]
    const bufKey = `${groupId}:${senderId}:${emoji}`
    const cleanText = stripChunkMarker(text)
    const existing = groupChunkBuffer.get(bufKey)

    if (existing) {
      // Append to existing buffer
      existing.chunks.push(cleanText)
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => {
        // Timeout: assemble what we have
        const buf = groupChunkBuffer.get(bufKey)
        if (buf) {
          const assembled = buf.chunks.join('\n\n')
          groupChunkBuffer.delete(bufKey)
          logger.info({ groupId, senderId, emoji, chunks: buf.chunks.length }, 'Chunk assembly timeout — processing partial')
          handleMessage(buf.firstCtx, assembled)
        }
      }, CHUNK_BUFFER_TIMEOUT_MS)
    } else {
      // First chunk — create buffer
      const timer = setTimeout(() => {
        const buf = groupChunkBuffer.get(bufKey)
        if (buf) {
          const assembled = buf.chunks.join('\n\n')
          groupChunkBuffer.delete(bufKey)
          logger.info({ groupId, senderId, emoji, chunks: buf.chunks.length }, 'Chunk assembly timeout — processing partial')
          handleMessage(buf.firstCtx, assembled)
        }
      }, CHUNK_BUFFER_TIMEOUT_MS)
      groupChunkBuffer.set(bufKey, { chunks: [cleanText], emoji, firstCtx: ctx, timer })
    }
    return true // consumed
  }

  // Check for final marker: emoji (without ⏩)
  const finalMatch = text.match(CHUNK_FINAL_RE)
  if (finalMatch) {
    const emoji = finalMatch[1]
    const bufKey = `${groupId}:${senderId}:${emoji}`
    const existing = groupChunkBuffer.get(bufKey)

    if (existing) {
      // Last chunk — assemble and process
      clearTimeout(existing.timer)
      const cleanText = stripChunkMarker(text)
      existing.chunks.push(cleanText)
      const assembled = existing.chunks.join('\n\n')
      groupChunkBuffer.delete(bufKey)
      logger.info({ groupId, senderId, emoji, chunks: existing.chunks.length }, 'Chunk assembly complete')
      handleMessage(existing.firstCtx, assembled)
      return true // consumed
    }
    // No buffer — could be a single message that happens to end with an emoji
    // from our set. Don't consume — let normal flow handle it.
    return false
  }

  // No chunk markers — not a chunk
  return false
}

// --- Main handler ---

async function handleMessage(
  ctx: Context,
  rawText: string,
  forceVoiceReply = false
): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  // Group chat: check mention + sender auth
  const inGroup = isGroupChat(ctx)
  if (inGroup) {
    if (!isAuthorised(chatId)) {
      debateLog(String(chatId), 'SKIP:not_authorised_group')
      return
    }
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
    if (!shouldProcessGroupMessage(ctx)) {
      debateLog(String(chatId), 'SKIP:should_not_process', { mentioned, replied, senderId: senderInfo?.id, senderIsBot: senderInfo?.is_bot })
      return
    }
    // Anti-loop: check iteration counter
    const chatIdStr = String(chatId)
    if (!incrementGroupIteration(chatIdStr)) {
      const state = getGroupState(chatIdStr)
      debateLog(chatIdStr, 'SKIP:iteration_limit', { count: state?.count, max: state?.max })
      if (state && state.count === state.max + 1) {
        await ctx.reply(`🛑 Ліміт ітерацій (${state.max}). /stop для reset.`)
      }
      return
    }
    // Parse debate roles from first message (user's initial prompt)
    const chatState = getGroupState(chatIdStr)
    const sender = ctx.message?.from
    debateLog(chatIdStr, 'ITERATION', { count: chatState?.count, senderIsBot: sender?.is_bot })
    if (chatState && chatState.count === 1 && sender && !sender.is_bot && ctx.me?.username) {
      const debate = parseDebateRoles(rawText, ctx.me.username)
      if (debate) {
        groupDebateState.set(chatIdStr, debate)
        debateLog(chatIdStr, 'DEBATE_ROLES_PARSED', { myRole: debate.myRole, partner: debate.partnerUsername })
      } else {
        debateLog(chatIdStr, 'DEBATE_ROLES_NOT_FOUND', { myUsername: ctx.me.username, textPreview: rawText.slice(0, 200) })
      }
    }

    // Add sender context prefix
    rawText = buildGroupPrefix(ctx) + rawText

    // Random delay for group messages (natural pacing, prevents race conditions)
    // Skip delay on first message (user's initial prompt) — only delay during active debate
    if (chatState && chatState.count > 1) {
      const delayMs = randomGroupDelay()
      const delaySec = Math.round(delayMs / 1000)
      debateLog(chatIdStr, 'DELAY', { seconds: delaySec, count: chatState.count })
      await ctx.reply(`⏳ Прийняв. Думаю ${delaySec}с...`).catch(() => {})
      await sleep(delayMs)
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
      // Build memory context (skip in debate mode — short-term memory pollutes debate quality)
      const isDebateMode = inGroup && !!getDebateState(chatIdStr)
      const memoryCtx = isDebateMode ? '' : await buildMemoryContext(chatIdStr, currentMessage)
      let fullMessage = memoryCtx
        ? `[Short-term context — fades over time. Use SaveFact for permanent storage.]\n${memoryCtx}\n\n${currentMessage}`
        : currentMessage

      // Get session
      const sessionId = getSession(chatIdStr)

      // Nudge LLM to name untitled sessions
      if (sessionId && !hasSessionTitle(sessionId)) {
        fullMessage += '\n\n[Session has no title yet. Call NameSession now with a short 3-5 word title.]'
      }

      // Start typing
      const sendTyping = () => ctx.api.sendChatAction(chatId, 'typing').catch(() => {})
      await sendTyping()

      // Create askUser callback for AskUser builtin tool
      const askUserCallback = async (question: string, options: { label: string; description?: string }[], keyboardMode: 'inline' | 'reply' | 'poll', customText?: string, customParseMode?: 'HTML' | 'MarkdownV2' | 'Markdown', multiple?: boolean) => {
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

        if (keyboardMode === 'reply') {
          const replyKeyboard = options.map(o => [{ text: o.label }])
          await ctx.api.sendMessage(chatId, msgText, {
            ...(parseMode ? { parse_mode: parseMode } : {}),
            reply_markup: { keyboard: replyKeyboard, one_time_keyboard: true, resize_keyboard: true },
          })

          return new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingReplyKeyboard.delete(chatIdStr)
              ctx.api.sendMessage(chatId, '⏰', { reply_markup: { remove_keyboard: true } })
                .then(msg => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {}))
                .catch(() => {})
              reject(new Error('timeout'))
            }, ASK_USER_TIMEOUT_MS)
            pendingReplyKeyboard.set(chatIdStr, { resolve, reject, timeout })
          })
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
        logger.info({ chatId: chatIdStr, model: currentModel, hasSession: !!sessionId }, 'Running agent')
        const result = await runAgent(fullMessage, sessionId, sendTyping, chatIdStr, auditHandler, currentModel, builtin?.server)
        text = result.text
        newSessionId = result.newSessionId
        usage = result.usage
      } catch (err) {
        logAudit(chatIdStr, 'error', err instanceof Error ? err.message : String(err))
        throw err
      }

      // Update session
      if (newSessionId) {
        setSession(chatIdStr, newSessionId)
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
        // Group mode: chunked with emoji ID markers (no telegraph)
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

  // --- Settings options (shared between command & callback handlers) ---
  const STYLE_OPTIONS = [
    { id: 'brunette', labelKey: 'style.brunette.label' },
    { id: 'blonde', labelKey: 'style.blonde.label' },
  ]
  const DELAY_OPTIONS = [
    { id: '0', label: '0с' },
    { id: '15', label: '15с' },
    { id: '30', label: '30с' },
    { id: '60', label: '60с' },
    { id: 'inf', label: '∞' },
  ]
  const TEAM_OPTIONS = [
    { id: 'all', labelKey: 'teamwork.all.label' },
    { id: 'result', labelKey: 'teamwork.result.label' },
    { id: 'none', labelKey: 'teamwork.none.label' },
  ]

  function buildSettingsMessage(chatId: string) {
    const t = chatT(chatId)
    const voiceOn = getChatSetting(chatId, 'voice') === '1'
    const statsOn = getChatSetting(chatId, 'stats') === '1'
    const factsOn = getChatSetting(chatId, 'fact_notify') !== '0' // ON by default
    const lang = getChatLang(chatId)
    const style = getChatSetting(chatId, 'progress_style') ?? 'brunette'
    const delay = getChatSetting(chatId, 'progress_delay') ?? '0'
    const team = getChatSetting(chatId, 'show_team_work') ?? 'none'

    const styleLabel = t(STYLE_OPTIONS.find(o => o.id === style)?.labelKey ?? 'style.brunette.label')
    const delayLabel = DELAY_OPTIONS.find(o => o.id === delay)?.label ?? DELAY_OPTIONS[0].label
    const teamLabel = t(TEAM_OPTIONS.find(o => o.id === team)?.labelKey ?? 'teamwork.none.label')
    const langLabel = t(`lang.${lang}`)

    const keyboard = [
      [{ text: t(voiceOn ? 'settings.voice.on' : 'settings.voice.off'), callback_data: 'settings:voice' }],
      [{ text: t(statsOn ? 'settings.stats.on' : 'settings.stats.off'), callback_data: 'settings:stats' }],
      [{ text: t(factsOn ? 'settings.facts.on' : 'settings.facts.off'), callback_data: 'settings:facts' }],
      [{ text: t('settings.lang', { label: langLabel }), callback_data: 'settings:lang' }],
      [{ text: t('settings.style', { label: styleLabel }), callback_data: 'settings:style' }],
      [{ text: t('settings.delay', { label: delayLabel }), callback_data: 'settings:delay' }],
      [{ text: t('settings.team', { label: teamLabel }), callback_data: 'settings:team' }],
    ]

    const lines = [
      `⚙️ <b>${t('cmd.settings.title')}</b>`,
      '',
      `🗣 <b>${voiceOn ? 'ON' : 'OFF'}</b> — ${t('settings.desc.voice')}`,
      `📊 <b>${statsOn ? 'ON' : 'OFF'}</b> — ${t('settings.desc.stats')}`,
      `🧠 <b>${factsOn ? 'ON' : 'OFF'}</b> — ${t('settings.desc.facts')}`,
      `🌐 <b>${langLabel}</b> — ${t('settings.desc.lang')}`,
      `🎨 <b>${styleLabel}</b> — ${t('settings.desc.style')}`,
      `⏱ <b>${delayLabel}</b> — ${t('settings.desc.delay')}`,
      `👥 <b>${teamLabel}</b> — ${t('settings.desc.team')}`,
    ]

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } }
  }

  // --- Session helpers ---

  const SESSIONS_PER_PAGE = 5
  const PROJECTS_PER_PAGE = 8

  function timeAgo(ts: number, t: BotT): string {
    const diff = Math.floor(Date.now() / 1000) - ts
    if (diff < 60) return t('cmd.session.ago.now')
    if (diff < 3600) return t('cmd.session.ago.min', { n: Math.floor(diff / 60) })
    if (diff < 86400) return t('cmd.session.ago.hour', { n: Math.floor(diff / 3600) })
    return t('cmd.session.ago.day', { n: Math.floor(diff / 86400) })
  }

  function formatSessionDate(ts: number): string {
    const d = new Date(ts * 1000)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const mon = String(d.getMonth() + 1).padStart(2, '0')
    return `${dd}.${mon} ${hh}:${mm}`
  }

  /** Build projects list view (level 1) */
  function buildProjectsMessage(chatId: string, page = 0) {
    const t = chatT(chatId)
    const currentSessionId = getSession(chatId)
    const projects = listClaudeProjects()
    const totalPages = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE))
    const safePage = Math.max(0, Math.min(page, totalPages - 1))
    const pageProjects = projects.slice(safePage * PROJECTS_PER_PAGE, (safePage + 1) * PROJECTS_PER_PAGE)

    const lines: string[] = [
      `📋 <b>${t('cmd.session.title')}</b>`,
      '',
    ]

    if (currentSessionId) {
      const shortId = currentSessionId.slice(0, 8)
      lines.push(`▸ <b>${t('cmd.session.active')}</b>: <code>${shortId}…</code>`)
      lines.push(`<code>claude --resume ${currentSessionId}</code>`)
    } else {
      lines.push(`▸ ${t('cmd.session.none')}`)
    }

    lines.push('')
    for (const p of pageProjects) {
      lines.push(`📁 <b>${escapeHtml(p.label)}</b> — ${p.sessionCount} ses, ${timeAgo(p.lastUpdated, t)}`)
    }

    if (totalPages > 1) {
      lines.push('', `📄 ${safePage + 1} / ${totalPages}`)
    }

    const keyboard: Array<Array<{ text: string; callback_data: string }>> = []
    // Project buttons — 2 per row
    for (let i = 0; i < pageProjects.length; i += 2) {
      const row: Array<{ text: string; callback_data: string }> = []
      row.push({ text: `📁 ${pageProjects[i].label}`, callback_data: `ses:proj:${pageProjects[i].key}:0` })
      if (i + 1 < pageProjects.length) {
        row.push({ text: `📁 ${pageProjects[i + 1].label}`, callback_data: `ses:proj:${pageProjects[i + 1].key}:0` })
      }
      keyboard.push(row)
    }

    // Navigation
    const navRow: Array<{ text: string; callback_data: string }> = []
    if (safePage > 0) navRow.push({ text: '◀️', callback_data: `ses:ppage:${safePage - 1}` })
    navRow.push({ text: t('cmd.session.btn.new'), callback_data: 'ses:new' })
    if (safePage < totalPages - 1) navRow.push({ text: '▶️', callback_data: `ses:ppage:${safePage + 1}` })
    keyboard.push(navRow)

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } }
  }

  /** Build sessions list for a specific project (level 2) */
  function buildSessionMessage(chatId: string, projectKey: string, page = 0) {
    const t = chatT(chatId)
    const currentSessionId = getSession(chatId)
    const allSessions = listDiskSessionsByKey(projectKey)
    const totalPages = Math.max(1, Math.ceil(allSessions.length / SESSIONS_PER_PAGE))
    const safePage = Math.max(0, Math.min(page, totalPages - 1))
    const pageSessions = allSessions.slice(safePage * SESSIONS_PER_PAGE, (safePage + 1) * SESSIONS_PER_PAGE)

    // Find project label
    const projects = listClaudeProjects()
    const proj = projects.find(p => p.key === projectKey)
    const projLabel = proj?.label ?? projectKey

    const lines: string[] = [
      `📁 <b>${escapeHtml(projLabel)}</b> — ${allSessions.length} sessions`,
      '',
    ]

    if (allSessions.length > 0) {
      for (const s of pageSessions) {
        const active = currentSessionId === s.sessionId ? ' ✓' : ''
        const date = formatSessionDate(s.updatedAt)
        const ago = timeAgo(s.updatedAt, t)
        lines.push(`<code>${s.sessionId.slice(0, 8)}</code>${active}`)
        lines.push(`  ${escapeHtml(s.title || s.preview)}`)
        lines.push(`  <i>${date} (${ago})</i>`)
        lines.push('')
      }
      if (totalPages > 1) {
        lines.push(`📄 ${safePage + 1} / ${totalPages}`)
      }
    } else {
      lines.push(t('cmd.session.empty'))
    }

    const keyboard: Array<Array<{ text: string; callback_data: string }>> = []

    for (const s of pageSessions) {
      const active = currentSessionId === s.sessionId ? '✓ ' : ''
      const label = s.title || s.preview.slice(0, 35) || s.sessionId.slice(0, 8)
      keyboard.push([
        { text: `${active}${label}`, callback_data: `ses:load:${s.sessionId}` },
      ])
    }

    // Navigation
    const navRow: Array<{ text: string; callback_data: string }> = []
    if (safePage > 0) navRow.push({ text: '◀️', callback_data: `ses:proj:${projectKey}:${safePage - 1}` })
    navRow.push({ text: '← back', callback_data: 'ses:projects:0' })
    if (safePage < totalPages - 1) navRow.push({ text: '▶️', callback_data: `ses:proj:${projectKey}:${safePage + 1}` })
    keyboard.push(navRow)

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } }
  }

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
    // Settings callback (unified handler for all settings toggles/cycles)
    if (ctx.callbackQuery?.data?.startsWith('settings:')) {
      const chatIdStr = String(ctx.chat?.id)
      if (!isAuthorised(ctx.chat!.id)) return
      const key = ctx.callbackQuery.data.replace('settings:', '')

      switch (key) {
        case 'voice':
          if (getChatSetting(chatIdStr, 'voice') === '1') deleteChatSetting(chatIdStr, 'voice')
          else setChatSetting(chatIdStr, 'voice', '1')
          break
        case 'stats':
          if (getChatSetting(chatIdStr, 'stats') === '1') deleteChatSetting(chatIdStr, 'stats')
          else setChatSetting(chatIdStr, 'stats', '1')
          break
        case 'facts':
          if (getChatSetting(chatIdStr, 'fact_notify') === '0') deleteChatSetting(chatIdStr, 'fact_notify')
          else setChatSetting(chatIdStr, 'fact_notify', '0')
          break
        case 'lang': {
          const cur = getChatLang(chatIdStr)
          setChatLang(chatIdStr, cur === 'uk' ? 'en' : 'uk')
          break
        }
        case 'style': {
          const cur = getChatSetting(chatIdStr, 'progress_style') ?? 'brunette'
          const ids = STYLE_OPTIONS.map(o => o.id)
          const next = ids[(ids.indexOf(cur) + 1) % ids.length]
          if (next === 'brunette') deleteChatSetting(chatIdStr, 'progress_style')
          else setChatSetting(chatIdStr, 'progress_style', next)
          break
        }
        case 'delay': {
          const cur = getChatSetting(chatIdStr, 'progress_delay') ?? '0'
          const ids = DELAY_OPTIONS.map(o => o.id)
          const next = ids[(ids.indexOf(cur) + 1) % ids.length]
          setChatSetting(chatIdStr, 'progress_delay', next)
          break
        }
        case 'team': {
          const cur = getChatSetting(chatIdStr, 'show_team_work') ?? 'none'
          const ids = TEAM_OPTIONS.map(o => o.id)
          const next = ids[(ids.indexOf(cur) + 1) % ids.length]
          if (next === 'none') deleteChatSetting(chatIdStr, 'show_team_work')
          else setChatSetting(chatIdStr, 'show_team_work', next)
          break
        }
      }

      const { text, reply_markup } = buildSettingsMessage(chatIdStr)
      await ctx.answerCallbackQuery()
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup })
      return
    }
    // Model selection callback
    if (ctx.callbackQuery?.data?.startsWith('model:')) {
      const chatIdStr = String(ctx.chat?.id)
      if (!isAuthorised(ctx.chat!.id)) return
      const modelId = ctx.callbackQuery.data.replace('model:', '')
      const validIds = MODELS.map(m => m.id)
      const _t = chatT(chatIdStr)
      if (!validIds.includes(modelId)) {
        await ctx.answerCallbackQuery({ text: _t('cb.unknownModel') })
        return
      }
      setModel(chatIdStr, modelId)
      const label = getModelLabel(modelId)
      await ctx.answerCallbackQuery({ text: _t('cmd.model.set', { label }) })

      // Update the message with new selection
      const lines = MODELS.map(m => {
        const marker = m.id === modelId ? '→' : '  '
        return `${marker} <b>${m.label}</b> — ${_t(`model.${m.id}`)}`
      })
      const keyboard = MODELS.map(m => {
        const btnLabel = m.id === modelId ? `✓ ${m.label}` : m.label
        return [{ text: btnLabel, callback_data: `model:${m.id}` }]
      })
      await ctx.editMessageText(
        `${_t('cmd.model.title', { label })}\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      )
      return
    }
    // Session callbacks
    if (ctx.callbackQuery?.data?.startsWith('ses:')) {
      const chatIdStr = String(ctx.chat?.id)
      if (!isAuthorised(ctx.chat!.id)) return
      const action = ctx.callbackQuery.data.slice(4) // remove 'ses:'
      const _t = chatT(chatIdStr)

      if (action === 'new') {
        clearSession(chatIdStr)
        logAudit(chatIdStr, 'session_clear')
        await ctx.answerCallbackQuery({ text: _t('cmd.newchat') })
        const { text, reply_markup } = buildProjectsMessage(chatIdStr)
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup })
        return
      }

      // Projects list pagination
      if (action.startsWith('projects:') || action.startsWith('ppage:')) {
        const page = parseInt(action.split(':')[1], 10)
        await ctx.answerCallbackQuery()
        const { text, reply_markup } = buildProjectsMessage(chatIdStr, page)
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup })
        return
      }

      // Open project sessions: ses:proj:<key>:<page>
      if (action.startsWith('proj:')) {
        const parts = action.slice(5) // remove 'proj:'
        const lastColon = parts.lastIndexOf(':')
        const projectKey = parts.slice(0, lastColon)
        const page = parseInt(parts.slice(lastColon + 1), 10) || 0
        await ctx.answerCallbackQuery()
        const { text, reply_markup } = buildSessionMessage(chatIdStr, projectKey, page)
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup })
        return
      }

      if (action.startsWith('load:')) {
        const sessionId = action.slice(5)
        setSession(chatIdStr, sessionId)
        const shortId = sessionId.slice(0, 8)
        await ctx.answerCallbackQuery({ text: _t('cmd.session.loaded', { name: shortId }) })

        // Show session info instead of menu
        const detail = getSessionDetail(sessionId)
        const lines: string[] = [
          `✅ <b>${_t('cmd.session.loaded', { name: shortId })}</b>`,
          '',
          `<code>claude --resume ${sessionId}</code>`,
        ]
        if (detail) {
          lines.push('', `📝 <b>${_t('cmd.session.first')}:</b>`)
          lines.push(escapeHtml(detail.firstMessage))
          if (detail.lastUserMessage) {
            lines.push('', `💬 <b>${_t('cmd.session.last')}:</b>`)
            lines.push(escapeHtml(detail.lastUserMessage))
          }
        }
        await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML' })
        return
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
    clearSession(chatIdStr)
    logAudit(chatIdStr, 'session_clear')
    await ctx.reply(chatT(chatIdStr)('cmd.newchat'))
  }
  bot.command('new', clearSessionHandler)
  bot.command('newchat', clearSessionHandler)
  bot.command('forget', clearSessionHandler)

  bot.command('memory', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return
    const t = chatT(chatId)
    const memories = getAllMemories(chatId, 10)
    if (memories.length === 0) {
      await ctx.reply(t('cmd.memory.empty'))
      return
    }
    const lines = memories.map(
      (m, i) => `${i + 1}. [${m.sector}] ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''} (salience: ${m.salience.toFixed(2)})`
    )
    await ctx.reply(`${t('cmd.memory.title')}\n\n${lines.join('\n')}`)
  })

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

  bot.command('model', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatIdStr = String(ctx.chat.id)
    const t = chatT(chatIdStr)
    const text = ctx.message?.text ?? ''
    const args = text.split(' ').slice(1).join(' ').trim().toLowerCase()

    const currentModel = getModel(chatIdStr)
    const validIds = MODELS.map(m => m.id)

    // Direct: /model sonnet
    if (args) {
      if (!validIds.includes(args)) {
        await ctx.reply(t('cmd.model.unknown', { args, models: validIds.join(', ') }))
        return
      }
      setModel(chatIdStr, args)
      await ctx.reply(t('cmd.model.set', { label: getModelLabel(args) }))
      return
    }

    // Interactive keyboard
    const keyboard = MODELS.map(m => {
      const label = m.id === currentModel ? `✓ ${m.label}` : m.label
      return [{ text: label, callback_data: `model:${m.id}` }]
    })

    const lines = MODELS.map(m => {
      const marker = m.id === currentModel ? '→' : '  '
      return `${marker} <b>${m.label}</b> — ${t(`model.${m.id}`)}`
    })

    await ctx.reply(
      `${t('cmd.model.title', { label: getModelLabel(currentModel) })}\n\n${lines.join('\n')}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    )
  })

  // --- /settings (unified settings menu) ---
  const openSettingsHandler = async (ctx: Context) => {
    if (!isAuthorised(ctx.chat!.id)) return
    const { text, reply_markup } = buildSettingsMessage(String(ctx.chat!.id))
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup })
  }
  bot.command('settings', openSettingsHandler)
  // Hidden aliases — old individual settings commands open /settings
  bot.command('voice', openSettingsHandler)
  bot.command('stats', openSettingsHandler)
  bot.command('lang', openSettingsHandler)
  bot.command('style', openSettingsHandler)
  bot.command('delay', openSettingsHandler)
  bot.command('show_team_work', openSettingsHandler)

  // --- /session (multi-session management) ---
  bot.command('session', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatIdStr = String(ctx.chat.id)
    const t = chatT(chatIdStr)
    const text = ctx.message?.text ?? ''
    const args = text.replace(/^\/session\s*/, '').trim()

    // /session import <session_id> — resume a CLI session in Telegram
    if (args.startsWith('import ')) {
      const sessionId = args.slice(7).trim()
      if (!sessionId) {
        await ctx.reply(t('cmd.session.import_usage'))
        return
      }
      setSession(chatIdStr, sessionId)
      await ctx.reply(t('cmd.session.imported'))
      return
    }

    // Default: show projects list
    const { text: msgText, reply_markup } = buildProjectsMessage(chatIdStr)
    await ctx.reply(msgText, { parse_mode: 'HTML', reply_markup })
  })

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
    await ctx.reply('🔄 Restarting...')
    setTimeout(() => process.exit(1), 500)
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
    await ctx.reply(`⏹ Діалог зупинено${state ? ` (було ${state.count} ітерацій)` : ''}.`)
  })

  // Text messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    const chatIdStr = String(ctx.chat.id)

    // Reply keyboard answer interception
    const pendingReply = pendingReplyKeyboard.get(chatIdStr)
    if (pendingReply) {
      clearTimeout(pendingReply.timeout)
      pendingReplyKeyboard.delete(chatIdStr)
      // Remove reply keyboard — must NOT delete this message, otherwise keyboard stays
      await ctx.reply(`→ ${text}`, { reply_markup: { remove_keyboard: true } }).catch(() => {})
      pendingReply.resolve(text)
      return
    }

    // skip known bot commands (they have their own handlers above)
    if (/^\/(start|chatid|new|newchat|forget|memory|voice|usage|stats|model|cancel|delay|style|show_team_work|admin|lang|settings|session|stop|restart)\b/.test(text)) return

    // Group chunk assembly: intercept multi-chunk messages from bots
    if (handleGroupChunk(ctx, text)) return

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
      await ctx.reply(`[voice]: ${transcript}`)
      await handleMessage(ctx, `[Voice transcribed]: ${transcript}`, true)
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
    { command: 'start', description: t('menu.start') },
    { command: 'new', description: t('menu.new') },
    { command: 'cancel', description: t('menu.cancel') },
    { command: 'model', description: t('menu.model') },
    { command: 'memory', description: t('menu.memory') },
    { command: 'usage', description: t('menu.usage') },
    { command: 'settings', description: t('menu.settings') },
    { command: 'session', description: t('menu.session') },
    { command: 'admin', description: t('menu.admin') },
    { command: 'restart', description: t('menu.restart') },
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
