import { Bot, Context, InputFile } from 'grammy'
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
  TELEGRAPH_ENABLED,
  BOT_NAME,
} from './config.js'
import { getSession, setSession, clearSession, getAllMemories, logUsage, getUsageSince, getChatSetting, setChatSetting, deleteChatSetting, logAudit } from './db.js'
import { runAgent, type UsageStats, type AskUserQuestion, type AskUserHandler } from './agent.js'
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

// --- AskUserQuestion pending responses ---
const pendingQuestions = new Map<string, {
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

// --- Main handler ---

async function handleMessage(
  ctx: Context,
  rawText: string,
  forceVoiceReply = false
): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return
  if (!isAuthorised(chatId)) {
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
      // Build memory context
      const memoryCtx = await buildMemoryContext(chatIdStr, currentMessage)
      const fullMessage = memoryCtx ? `${memoryCtx}\n\n${currentMessage}` : currentMessage

      // Get session
      const sessionId = getSession(chatIdStr)

      // Start typing
      const sendTyping = () => ctx.api.sendChatAction(chatId, 'typing').catch(() => {})
      await sendTyping()

      // Create builtin MCP server (image gen, voice, telegraph, media sending)
      const builtin = createBuiltinMcpServer(ctx, chatId)

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
        // AskUserQuestion handler: send to Telegram, wait for button click
        const askUserHandler: AskUserHandler = async (questions) => {
          const answers: string[] = []
          for (const q of questions) {
            const text = `❓ <b>${escapeHtml(q.header)}</b>\n\n${escapeHtml(q.question)}\n\n${q.options.map(o => `• <b>${escapeHtml(o.label)}</b> — ${escapeHtml(o.description)}`).join('\n')}`
            const keyboard = q.options.map(o => [{ text: o.label, callback_data: `ask:${o.label}` }])
            // Add "Other" option
            keyboard.push([{ text: chatT(chatIdStr)('cb.askSkip'), callback_data: 'ask:__skip__' }])

            await ctx.api.sendMessage(chatId, text, {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: keyboard },
            })

            const answer = await new Promise<string>((resolve, reject) => {
              const timeout = setTimeout(() => {
                pendingQuestions.delete(chatIdStr)
                reject(new Error('timeout'))
              }, ASK_USER_TIMEOUT_MS)
              pendingQuestions.set(chatIdStr, { resolve, reject, timeout })
            })

            if (answer !== '__skip__') answers.push(`${q.header}: ${answer}`)
          }
          return answers.join('; ') || chatT(chatIdStr)('cb.userSkipped')
        }

        const result = await runAgent(fullMessage, sessionId, sendTyping, chatIdStr, auditHandler, getModel(chatIdStr), askUserHandler, builtin?.server)
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

      // No follow-up — send the result
      if (!text) {
        await ctx.reply(chatT(chatIdStr)('auth.noReply'))
        return
      }

      // Save memory
      await saveConversationTurn(chatIdStr, currentMessage, text)

      // Log usage
      const responseTimeMs = Date.now() - startTime
      if (usage) {
        logUsage(chatIdStr, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens, usage.costUSD, responseTimeMs)
        logger.info({ chatId: chatIdStr, ms: responseTimeMs, cost: `$${usage.costUSD.toFixed(4)}`, in: usage.inputTokens, out: usage.outputTokens }, 'Response sent')
      }

      // Send text — skip auto-telegraph if agent already used PublishTelegraph
      const shouldTelegraph = TELEGRAPH_ENABLED && shouldUseTelegraph(text)
        && !builtin?.usedTools.has('PublishTelegraph')
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
      [{ text: t('settings.lang', { label: langLabel }), callback_data: 'settings:lang' }],
      [{ text: t('settings.style', { label: styleLabel }), callback_data: 'settings:style' }],
      [{ text: t('settings.delay', { label: delayLabel }), callback_data: 'settings:delay' }],
      [{ text: t('settings.team', { label: teamLabel }), callback_data: 'settings:team' }],
    ]

    return { text: `⚙️ <b>${t('cmd.settings.title')}</b>`, reply_markup: { inline_keyboard: keyboard } }
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
        stopAdmin()
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

  // Text messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    // skip known bot commands (they have their own handlers above)
    if (/^\/(start|chatid|new|newchat|forget|memory|voice|usage|stats|model|cancel|delay|style|show_team_work|admin|lang|settings)\b/.test(text)) return
    // Strip leading / from unknown commands so SDK doesn't interpret as slash command
    const cleanText = text.startsWith('/') ? text.slice(1) : text
    if (text.startsWith('/')) {
      logAudit(String(ctx.chat.id), 'command', text.split(' ')[0])
    }
    await handleMessage(ctx, cleanText)
  })

  // Voice messages
  bot.on('message:voice', async (ctx) => {
    const chatId = ctx.chat.id
    if (!isAuthorised(chatId)) return

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
    if (!isAuthorised(chatId)) return

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
    if (!isAuthorised(chatId)) return

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
    if (!isAuthorised(chatId)) return

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
    { command: 'admin', description: t('menu.admin') },
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
