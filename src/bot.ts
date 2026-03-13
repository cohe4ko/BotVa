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
import { generateImage, editImage } from './imagen.js'
import { getModel, setModel, MODELS, getModelLabel } from './model.js'

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
    await ctx.reply(`Немає доступу. Твій chat ID: ${chatId}`)
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

  // Queue the request
  await queueRequest(chatIdStr, async () => {
    let currentMessage = rawText

    // Progress reporter persists across follow-up iterations
    const delaySetting = getChatSetting(chatIdStr, 'progress_delay')
    const delayMs = delaySetting === 'inf' ? Infinity : delaySetting ? parseInt(delaySetting, 10) * 1000 : undefined
    const cuteMode = getChatSetting(chatIdStr, 'progress_style') === 'blonde'
    const reporter = new ProgressReporter(chatId, ctx.api, delayMs, cuteMode)

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
            keyboard.push([{ text: '✏️ Інше (пропустити)', callback_data: 'ask:__skip__' }])

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
          return answers.join('; ') || 'Користувач пропустив питання'
        }

        const result = await runAgent(fullMessage, sessionId, sendTyping, chatIdStr, auditHandler, getModel(chatIdStr), askUserHandler)
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
        currentMessage = `[Користувач додав повідомлення під час твоєї роботи]: ${followup}\n\nВрахуй це повідомлення і продовжуй виконувати попереднє завдання.`
        continue
      }

      // No follow-up — normal cleanup (delayed delete)
      await reporter.cleanup()

      // No follow-up — send the result
      if (!text) {
        await ctx.reply('(без відповіді)')
        return
      }

      // Save memory
      await saveConversationTurn(chatIdStr, currentMessage, text)

      // Log usage
      const responseTimeMs = Date.now() - startTime
      if (usage) {
        logUsage(chatIdStr, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens, usage.costUSD, responseTimeMs)
      }

      // Send text
      if (TELEGRAPH_ENABLED && shouldUseTelegraph(text)) {
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

      // Voice reply async
      const shouldVoice = forceVoiceReply || getChatSetting(chatIdStr, 'voice') === '1'
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
        await ctx.answerCallbackQuery({ text: 'Питання вже не актуальне' })
      }
      return
    }
    // Admin stop callback
    if (ctx.callbackQuery?.data === 'admin:stop') {
      if (!isAuthorised(ctx.chat!.id)) return
      const { isAdminRunning, stopAdmin } = await import('./admin/on-demand.js')
      const status = isAdminRunning()
      if (!status.running) {
        await ctx.answerCallbackQuery({ text: 'Admin panel не запущена' })
      } else {
        stopAdmin()
        await ctx.answerCallbackQuery({ text: 'Зупинено' })
      }
      try {
        await ctx.editMessageText('Admin panel зупинено.')
      } catch {}
      return
    }
    // Stop button callback
    if (ctx.callbackQuery?.data?.startsWith('stop:')) {
      const targetChatId = ctx.callbackQuery.data.split(':')[1]
      if (String(ctx.chat?.id) === targetChatId) {
        const interrupted = await interruptRequest(targetChatId)
        await ctx.answerCallbackQuery({ text: interrupted ? 'Зупиняю...' : 'Нічого зупиняти' })
      }
      return // don't pass to next middleware
    }
    // Delay selection callback
    if (ctx.callbackQuery?.data?.startsWith('delay:')) {
      const chatIdStr = String(ctx.chat?.id)
      if (!isAuthorised(ctx.chat!.id)) return
      const val = ctx.callbackQuery.data.replace('delay:', '')
      const DELAY_OPTIONS = [
        { id: '0', label: '0с', description: 'одразу' },
        { id: '15', label: '15с', description: '15 секунд' },
        { id: '30', label: '30с', description: '30 секунд' },
        { id: '60', label: '60с', description: '1 хвилина' },
        { id: 'inf', label: '∞', description: 'не видаляти' },
      ]
      if (val === '0') {
        deleteChatSetting(chatIdStr, 'progress_delay')
        setChatSetting(chatIdStr, 'progress_delay', '0')
      } else if (val === 'inf') {
        setChatSetting(chatIdStr, 'progress_delay', 'inf')
      } else {
        setChatSetting(chatIdStr, 'progress_delay', val)
      }
      const currentLabel = DELAY_OPTIONS.find(o => o.id === val)?.description ?? val
      await ctx.answerCallbackQuery({ text: `Затримка: ${currentLabel}` })

      const keyboard = DELAY_OPTIONS.map(o => {
        const btnLabel = o.id === val ? `✓ ${o.label}` : o.label
        return [{ text: btnLabel, callback_data: `delay:${o.id}` }]
      })
      const lines = DELAY_OPTIONS.map(o => {
        const marker = o.id === val ? '→' : '  '
        return `${marker} <b>${o.label}</b> — ${o.description}`
      })
      await ctx.editMessageText(
        `Затримка видалення прогресу: <b>${currentLabel}</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      )
      return
    }
    // Show team work callback
    if (ctx.callbackQuery?.data?.startsWith('show_team_work:')) {
      const chatIdStr = String(ctx.chat?.id)
      if (!isAuthorised(ctx.chat!.id)) return
      const val = ctx.callbackQuery.data.replace('show_team_work:', '')
      const SHOW_OPTIONS = [
        { id: 'all', label: '📢 Все', description: 'запит, відповідь, typing' },
        { id: 'result', label: '📋 Запит і відповідь', description: 'тільки результат' },
        { id: 'none', label: '🔇 Нічого', description: 'не показувати' },
      ]
      if (val === 'none') {
        deleteChatSetting(chatIdStr, 'show_team_work')
      } else {
        setChatSetting(chatIdStr, 'show_team_work', val)
      }
      const currentLabel = SHOW_OPTIONS.find(o => o.id === val)?.description ?? val
      await ctx.answerCallbackQuery({ text: `Видимість: ${currentLabel}` })

      const keyboard = SHOW_OPTIONS.map(o => {
        const btnLabel = o.id === val ? `✓ ${o.label}` : o.label
        return [{ text: btnLabel, callback_data: `show_team_work:${o.id}` }]
      })
      const lines = SHOW_OPTIONS.map(o => {
        const marker = o.id === val ? '→' : '  '
        return `${marker} ${o.label} — ${o.description}`
      })
      await ctx.editMessageText(
        `Видимість командної роботи: <b>${currentLabel}</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      )
      return
    }
    // Style selection callback
    if (ctx.callbackQuery?.data?.startsWith('style:')) {
      const chatIdStr = String(ctx.chat?.id)
      if (!isAuthorised(ctx.chat!.id)) return
      const val = ctx.callbackQuery.data.replace('style:', '')
      const STYLE_OPTIONS = [
        { id: 'brunette', label: '👩‍💻 Брюнетка', description: 'технічний стиль' },
        { id: 'blonde', label: '👱‍♀️ Блондинка', description: 'милий стиль' },
      ]
      if (val === 'brunette') {
        deleteChatSetting(chatIdStr, 'progress_style')
      } else {
        setChatSetting(chatIdStr, 'progress_style', val)
      }
      const currentLabel = STYLE_OPTIONS.find(o => o.id === val)?.description ?? val
      await ctx.answerCallbackQuery({ text: `Стиль: ${currentLabel}` })

      const keyboard = STYLE_OPTIONS.map(o => {
        const btnLabel = o.id === val ? `✓ ${o.label}` : o.label
        return [{ text: btnLabel, callback_data: `style:${o.id}` }]
      })
      const lines = STYLE_OPTIONS.map(o => {
        const marker = o.id === val ? '→' : '  '
        return `${marker} ${o.label} — ${o.description}`
      })
      await ctx.editMessageText(
        `Стиль прогресу: <b>${currentLabel}</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      )
      return
    }
    // Model selection callback
    if (ctx.callbackQuery?.data?.startsWith('model:')) {
      const chatIdStr = String(ctx.chat?.id)
      if (!isAuthorised(ctx.chat!.id)) return
      const modelId = ctx.callbackQuery.data.replace('model:', '')
      const validIds = MODELS.map(m => m.id)
      if (!validIds.includes(modelId)) {
        await ctx.answerCallbackQuery({ text: 'Невідома модель' })
        return
      }
      setModel(chatIdStr, modelId)
      const label = getModelLabel(modelId)
      await ctx.answerCallbackQuery({ text: `Модель: ${label}` })

      // Update the message with new selection
      const lines = MODELS.map(m => {
        const marker = m.id === modelId ? '→' : '  '
        return `${marker} <b>${m.label}</b> — ${m.description}`
      })
      const keyboard = MODELS.map(m => {
        const btnLabel = m.id === modelId ? `✓ ${m.label}` : m.label
        return [{ text: btnLabel, callback_data: `model:${m.id}` }]
      })
      await ctx.editMessageText(
        `Модель: <b>${label}</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      )
      return
    }
    // /cancel command
    if (ctx.message?.text === '/cancel') {
      const chatIdStr = String(ctx.chat?.id)
      if (!isAuthorised(ctx.chat!.id)) return
      const cancelled = await cancelRequest(chatIdStr)
      const cleared = clearQueue(chatIdStr)
      if (cancelled || cleared > 0) {
        const parts: string[] = []
        if (cancelled) parts.push('запит скасовано')
        if (cleared > 0) parts.push(`${cleared} в черзі очищено`)
        await ctx.reply(parts.join(', '))
      } else {
        await ctx.reply('Нічого скасовувати.')
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
    await ctx.reply(
      `BotVa на зв'язку.\n\nТвій chat ID: <code>${chatId}</code>\n\n/chatid -- показати chat ID\n/newchat -- нова сесія\n/cancel -- скасувати поточний запит\n/model -- змінити модель AI\n/memory -- останні спогади\n/voice -- перемкнути голосові відповіді\n/usage -- використання за годину/добу/тиждень\n/stats -- перемкнути статистику під повідомленнями\n/img -- згенерувати зображення\nФото + /edit -- відредагувати зображення\n/admin -- адмін панель`,
      { parse_mode: 'HTML' }
    )
  })

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Твій chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' })
  })

  // /cancel handled in pre-middleware above

  bot.command('newchat', async (ctx) => {
    const chatIdStr = String(ctx.chat.id)
    clearSession(chatIdStr)
    logAudit(chatIdStr, 'session_clear')
    await ctx.reply('Сесію очищено. Починаємо з нуля.')
  })

  bot.command('forget', async (ctx) => {
    const chatIdStr = String(ctx.chat.id)
    clearSession(chatIdStr)
    logAudit(chatIdStr, 'session_clear')
    await ctx.reply('Сесію очищено. Починаємо з нуля.')
  })

  bot.command('memory', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return
    const memories = getAllMemories(chatId, 10)
    if (memories.length === 0) {
      await ctx.reply('Спогадів поки немає.')
      return
    }
    const lines = memories.map(
      (m, i) => `${i + 1}. [${m.sector}] ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''} (salience: ${m.salience.toFixed(2)})`
    )
    await ctx.reply(`Останні спогади:\n\n${lines.join('\n')}`)
  })

  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat.id)
    const caps = voiceCapabilities()
    if (!caps.tts) {
      await ctx.reply('TTS не налаштовано. Голосові відповіді недоступні.')
      return
    }
    if (getChatSetting(chatId, 'voice') === '1') {
      deleteChatSetting(chatId, 'voice')
      await ctx.reply('Голосові відповіді ВИМКНЕНО.')
    } else {
      setChatSetting(chatId, 'voice', '1')
      await ctx.reply('Голосові відповіді УВІМКНЕНО.')
    }
  })

  bot.command('usage', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
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
      '<b>Використання BotVa</b>',
      '',
      `<b>За годину:</b> ${hour.requests} запитів | ${k(hour.inputTokens + hour.outputTokens)} токенів | ${usd(hour.costUSD)}`,
      `<b>За добу:</b> ${day.requests} запитів | ${k(day.inputTokens + day.outputTokens)} токенів | ${usd(day.costUSD)}`,
      `<b>За тиждень:</b> ${week.requests} запитів | ${k(week.inputTokens + week.outputTokens)} токенів | ${usd(week.costUSD)}`,
      '',
      `Деталі за тиждень:`,
      `  in: ${k(week.inputTokens)} | out: ${k(week.outputTokens)}`,
      `  cache read: ${k(week.cacheReadTokens)} | cache new: ${k(week.cacheCreationTokens)}`,
    ]
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })

  bot.command('stats', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (getChatSetting(chatId, 'stats') === '1') {
      deleteChatSetting(chatId, 'stats')
      await ctx.reply('Статистика під повідомленнями ВИМКНЕНА.')
    } else {
      setChatSetting(chatId, 'stats', '1')
      await ctx.reply('Статистика під повідомленнями УВІМКНЕНА.')
    }
  })

  bot.command('schedule', async (ctx) => {
    const chatId = String(ctx.chat.id)
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message?.text ?? ''
    const args = text.replace(/^\/schedule\s*/, '').trim()

    if (!args) {
      await ctx.reply(
        'Використання:\n/schedule create "промпт" "cron"\n/schedule list\n/schedule delete <id>\n/schedule pause <id>\n/schedule resume <id>'
      )
      return
    }

    // Forward to schedule-cli logic inline
    await ctx.reply(`Використай CLI: node dist/schedule-cli.js ${args}`)
  })

  // Image generation
  bot.command('img', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const text = ctx.message?.text ?? ''
    const prompt = text.replace(/^\/img\s*/, '').trim()

    if (!prompt) {
      await ctx.reply('Використання: /img <опис зображення>')
      return
    }

    await ctx.api.sendChatAction(ctx.chat.id, 'upload_photo').catch(() => {})

    try {
      const result = await generateImage(prompt)
      if (result.imagePath) {
        await ctx.replyWithPhoto(new InputFile(result.imagePath), {
          caption: result.text?.slice(0, 1024) ?? undefined,
        })
      } else {
        await ctx.reply(result.text ?? 'Не вдалося згенерувати зображення.')
      }
    } catch (err) {
      logger.error({ err }, 'Image generation failed')
      await ctx.reply(`Помилка генерації: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  bot.command('model', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatIdStr = String(ctx.chat.id)
    const text = ctx.message?.text ?? ''
    const args = text.split(' ').slice(1).join(' ').trim().toLowerCase()

    const currentModel = getModel(chatIdStr)
    const validIds = MODELS.map(m => m.id)

    // Direct: /model sonnet
    if (args) {
      if (!validIds.includes(args)) {
        await ctx.reply(`Невідома модель: ${args}\nДоступні: ${validIds.join(', ')}`)
        return
      }
      setModel(chatIdStr, args)
      await ctx.reply(`Модель: ${getModelLabel(args)}`)
      return
    }

    // Interactive keyboard
    const keyboard = MODELS.map(m => {
      const label = m.id === currentModel ? `✓ ${m.label}` : m.label
      return [{ text: label, callback_data: `model:${m.id}` }]
    })

    const lines = MODELS.map(m => {
      const marker = m.id === currentModel ? '→' : '  '
      return `${marker} <b>${m.label}</b> — ${m.description}`
    })

    await ctx.reply(
      `Модель: <b>${getModelLabel(currentModel)}</b>\n\n${lines.join('\n')}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    )
  })

  bot.command('style', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatIdStr = String(ctx.chat.id)
    const current = getChatSetting(chatIdStr, 'progress_style') ?? 'brunette'

    const STYLE_OPTIONS = [
      { id: 'brunette', label: '👩‍💻 Брюнетка', description: 'технічний стиль' },
      { id: 'blonde', label: '👱‍♀️ Блондинка', description: 'милий стиль' },
    ]

    const keyboard = STYLE_OPTIONS.map(o => {
      const label = o.id === current ? `✓ ${o.label}` : o.label
      return [{ text: label, callback_data: `style:${o.id}` }]
    })

    const currentOption = STYLE_OPTIONS.find(o => o.id === current)
    const currentLabel = currentOption?.description ?? current
    const lines = STYLE_OPTIONS.map(o => {
      const marker = o.id === current ? '→' : '  '
      return `${marker} ${o.label} — ${o.description}`
    })

    await ctx.reply(
      `Стиль прогресу: <b>${currentLabel}</b>\n\n${lines.join('\n')}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    )
  })

  bot.command('show_team_work', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatIdStr = String(ctx.chat.id)
    const current = getChatSetting(chatIdStr, 'show_team_work') ?? 'none'

    const SHOW_OPTIONS = [
      { id: 'all', label: '📢 Все', description: 'запит, відповідь, typing' },
      { id: 'result', label: '📋 Запит і відповідь', description: 'тільки результат' },
      { id: 'none', label: '🔇 Нічого', description: 'не показувати' },
    ]

    const keyboard = SHOW_OPTIONS.map(o => {
      const label = o.id === current ? `✓ ${o.label}` : o.label
      return [{ text: label, callback_data: `show_team_work:${o.id}` }]
    })

    const currentOption = SHOW_OPTIONS.find(o => o.id === current)
    const currentLabel = currentOption?.description ?? current
    const lines = SHOW_OPTIONS.map(o => {
      const marker = o.id === current ? '→' : '  '
      return `${marker} ${o.label} — ${o.description}`
    })

    await ctx.reply(
      `Видимість командної роботи: <b>${currentLabel}</b>\n\n${lines.join('\n')}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    )
  })

  bot.command('delay', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return
    const chatIdStr = String(ctx.chat.id)
    const current = getChatSetting(chatIdStr, 'progress_delay')

    const DELAY_OPTIONS = [
      { id: '0', label: '0с', description: 'одразу' },
      { id: '15', label: '15с', description: '15 секунд' },
      { id: '30', label: '30с', description: '30 секунд' },
      { id: '60', label: '60с', description: '1 хвилина' },
      { id: 'inf', label: '∞', description: 'не видаляти' },
    ]

    const keyboard = DELAY_OPTIONS.map(o => {
      const label = current && o.id === current ? `✓ ${o.label}` : o.label
      return [{ text: label, callback_data: `delay:${o.id}` }]
    })

    const currentOption = current ? DELAY_OPTIONS.find(o => o.id === current) : null
    const currentLabel = currentOption?.description ?? 'за замовчуванням (~18с)'
    const lines = DELAY_OPTIONS.map(o => {
      const marker = current && o.id === current ? '→' : '  '
      return `${marker} <b>${o.label}</b> — ${o.description}`
    })

    await ctx.reply(
      `Затримка видалення прогресу: <b>${currentLabel}</b>\n\n${lines.join('\n')}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    )
  })

  bot.command('admin', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return

    const { isAdminRunning, startAdmin } = await import('./admin/on-demand.js')

    const status = isAdminRunning()
    if (status.running) {
      const url = `${status.url}/?token=${status.token}`
      await ctx.reply(
        'Admin panel працює:',
        { reply_markup: { inline_keyboard: [
          [{ text: '🔧 Відкрити', url }],
          [{ text: '🛑 Зупинити', callback_data: 'admin:stop' }],
        ] } }
      )
      return
    }

    const port = parseInt(process.env.ADMIN_PORT || '3000', 10)
    const chatId = ctx.chat.id

    const { url } = startAdmin(port, BOT_NAME, () => {
      ctx.api.sendMessage(chatId, 'Admin panel зупинено (20 хв неактивності).').catch(() => {})
    })

    await ctx.reply(
      'Admin panel запущено:',
      {
        reply_markup: { inline_keyboard: [
          [{ text: '🔧 Відкрити', url }],
          [{ text: '🛑 Зупинити', callback_data: 'admin:stop' }],
        ] },
      }
    )
  })

  // Text messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    // skip known bot commands (they have their own handlers above)
    if (/^\/(start|chatid|newchat|forget|memory|voice|usage|stats|schedule|img|model|cancel|delay|style|show_team_work|admin)\b/.test(text)) return
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

    const caps = voiceCapabilities()
    if (!caps.stt) {
      await ctx.reply('Транскрипцію голосу не налаштовано. Додай GROQ_API_KEY в .env')
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
      await ctx.reply('Не вдалося обробити голосове повідомлення.')
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
        const editPrompt = caption.replace(/^\/edit\s*/, '').trim()
        if (!editPrompt) {
          await ctx.reply('Додай опис що змінити: /edit <опис>')
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
            await ctx.reply(result.text ?? 'Не вдалося відредагувати зображення.')
          }
        } catch (err) {
          logger.error({ err }, 'Image editing failed')
          await ctx.reply(`Помилка редагування: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }

      // Default: pass to Claude
      const message = buildPhotoMessage(localPath, caption)
      await handleMessage(ctx, message)
    } catch (err) {
      logger.error({ err }, 'Photo processing failed')
      await ctx.reply('Не вдалося обробити фото.')
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
      await ctx.reply('Не вдалося обробити документ.')
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
      await ctx.reply('Не вдалося обробити відео.')
    }
  })


  bot.catch((err) => {
    logger.error({ err: err.error }, 'Bot error')
  })

  // Register commands menu in Telegram
  bot.api.setMyCommands([
    { command: 'start', description: 'Почати роботу' },
    { command: 'newchat', description: 'Нова сесія (очистити контекст)' },
    { command: 'cancel', description: 'Скасувати поточний запит' },
    { command: 'voice', description: 'Увімк/вимк голосові відповіді' },
    { command: 'usage', description: 'Статистика використання' },
    { command: 'stats', description: 'Увімк/вимк статистику під повідомленнями' },
    { command: 'memory', description: 'Показати останні спогади' },
    { command: 'img', description: 'Згенерувати зображення' },
    { command: 'delay', description: 'Затримка видалення прогресу' },
    { command: 'style', description: 'Стиль прогресу (блондинка/брюнетка)' },
    { command: 'chatid', description: 'Показати chat ID' },
    { command: 'show_team_work', description: 'Видимість командної роботи' },
    { command: 'admin', description: 'Запустити/зупинити адмін панель' },
  ]).catch(err => logger.error({ err }, 'Failed to set bot commands'))

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
