import type { Api } from 'grammy'
import { InlineKeyboard } from 'grammy'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { logger } from './logger.js'
import { createBotT, type BotLang, type BotT } from './bot-i18n.js'
import { isInterrupted } from './request-queue.js'
import { draftRichMessage } from './rich-message.js'

const THROTTLE_MS = 1500
const MAX_LINES = 20
// Full-log mode (PROGRESS_FULL_LOG): no eviction. Instead the message is frozen
// and a new linked message continues the log once it approaches these bounds.
const MAX_LINES_FULL = 40
// Safety threshold below the Telegram hard limit (4096) — roll over before the
// rendered snapshot can overflow.
const ROLLOVER_CHARS = 3500
const TEXT_PREVIEW_LEN = 200
// Стрімінг у прогрес-вікні: скільки останніх символів показувати
const STREAM_PREVIEW_LEN = 600
// Трансляція мислення (thinking_delta): повністю розгорнутий blockquote з хвостом процесу
const THINKING_PREVIEW_LEN = 2000
const DEFAULT_CLEANUP_DELAY_MS = 18_000

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Light markdown → Telegram HTML for progress display */
function mdToHtml(md: string): string {
  let s = escapeHtml(md)
  // inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  // bold **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/__(.+?)__/g, '<b>$1</b>')
  // italic *text* or _text_
  s = s.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>')
  s = s.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>')
  // strikethrough
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>')
  // headings → bold
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  return s
}

// Tool-specific icons for standard mode
const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Write: '✏️',
  Edit: '✂️',
  Glob: '🔍',
  Grep: '👀',
  Bash: '⚡',
  WebSearch: '🌐',
  WebFetch: '📥',
  Agent: '🤖',
  TodoWrite: '📝',
  TodoRead: '📋',
  NotebookEdit: '📓',
  Skill: '✨',
  AskGemini: '💎',
  GeminiSearch: '💎',
  // Builtin tools
  GenerateImage: '🎨',
  EditImage: '🖌️',
  TextToSpeech: '🗣️',
  SendMedia: '📎',
  SetReaction: '😊',
  ForwardMessage: '↗️',
  PublishTelegraph: '📰',
  ShareFile: '📤',
  ListGalleryImages: '🖼️',
  SendGalleryImage: '🖼️',
  DeleteGalleryImage: '🖼️',
  CreateBackup: '💾',
  ListBackups: '💾',
  VerifyBackup: '💾',
  RestoreBackup: '💾',
  DeleteBackup: '💾',
  SendEmail: '📧',
  SaveFact: '🧠',
  SearchMemory: '🧠',
  DeleteFact: '🧹',
  CreateBot: '🤖',
  DeleteBot: '🤖',
  ListBots: '🤖',
  CurrencyRates: '💱',
  GetCurrentTime: '🕐',
  CreateReminder: '⏰',
  ListReminders: '⏰',
  DeleteReminder: '⏰',
  RunPython: '🐍',
  AskUser: '❓',
  TakeScreenshot: '📸',
  NameSession: '🏷️',
  ReadWorkspaceFile: '📂',
  WriteWorkspaceFile: '📂',
}

// MCP server icon prefixes
const MCP_ICONS: Record<string, string> = {
  'bitrix24': '📋',
  'home-assistant': '🏠',
  'stagehand': '🎭',
  'playwright': '🎭',
  'macos-control': '🖥️',
  'google-workspace': '📧',
  'meta-ads': '📣',
  'notion': '📔',
  'pubmed': '🔬',
  'medical': '💊',
  'spacedome': '⛺',
  'freecad': '📐',
  'miro': '🎨',
}

// Tools to hide from progress display (infrastructure, not user-facing)
const HIDDEN_TOOLS = new Set(['ToolSearch', 'ToolFetch'])
const HIDDEN_MCP_SERVERS = new Set(['plugin_telegram_telegram'])

/** Strip mcp__ prefix: mcp__builtin__X → X, mcp__server__tool → server_tool */
function shortToolName(name: string): string {
  // Split on double underscore: mcp__server_name__tool_name
  const parts = name.split('__')
  if (parts.length >= 3 && parts[0] === 'mcp') {
    const server = parts[1]
    const tool = parts.slice(2).join('__')
    if (server === 'builtin') return tool
    return `${server}_${tool}`
  }
  return name
}

function isHiddenTool(name: string): boolean {
  if (HIDDEN_TOOLS.has(name)) return true
  const parts = name.split('__')
  if (parts.length >= 3 && parts[0] === 'mcp') {
    return HIDDEN_MCP_SERVERS.has(parts[1])
  }
  return false
}

function toolIcon(name: string): string {
  const short = shortToolName(name)
  if (TOOL_ICONS[short]) return TOOL_ICONS[short]
  const mcpPrefix = Object.keys(MCP_ICONS).find(p => name.includes(p))
  return mcpPrefix ? MCP_ICONS[mcpPrefix] : '🔧'
}

// Regex matching any tool icon (for replacement in progress/result), works inside <code>
const TOOL_ICON_RE = /^(<code>)?(\s*)[📖✏️✂️🔍👀⚡🌐📥🤖📝📋📓✨💎🔧⏳✅🏠🎭🖥️📧📣📔🔬💊⛺📐🎨🖌️🗣️📎😊↗️📰📤🖼️💾🧠🧹💱🕐⏰🐍❓📸🏷️📂📦💫][\uFE0F]?/

function toolDetail(name: string, input: Record<string, unknown>): string {
  const i = input
  const short = shortToolName(name)
  switch (short) {
    case 'Read':
      return shortPath(String(i.file_path ?? ''))
    case 'Write':
      return shortPath(String(i.file_path ?? ''))
    case 'Edit':
      return shortPath(String(i.file_path ?? ''))
    case 'Glob':
      return String(i.pattern ?? '')
    case 'Grep':
      return `/${i.pattern ?? ''}/ ${i.path ? 'in ' + shortPath(String(i.path)) : ''}`
    case 'Bash': {
      const cmd = String(i.command ?? '')
      return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd
    }
    case 'WebSearch':
      return String(i.query ?? '')
    case 'WebFetch':
      return String(i.url ?? '').slice(0, 60)
    case 'Agent':
      return String(i.description ?? i.prompt ?? '').slice(0, 60)
    case 'AskGemini':
      return String(i.prompt ?? '').slice(0, 60)
    case 'GeminiSearch':
      return String(i.query ?? '').slice(0, 60)
    case 'TodoWrite':
    case 'TodoRead':
      return ''
    default: {
      // MCP tools: show first string value
      const firstVal = Object.values(i).find(v => typeof v === 'string')
      return firstVal ? String(firstVal).slice(0, 60) : ''
    }
  }
}

function shortPath(p: string): string {
  const parts = p.split('/')
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p
}

function resultPreview(result: unknown): string {
  if (!result) return ''
  let text = ''
  if (typeof result === 'string') {
    text = result
  } else if (Array.isArray(result)) {
    for (const block of result) {
      if (block?.type === 'text' && block.text) {
        text += block.text
      }
    }
  } else if (typeof result === 'object' && result !== null) {
    text = JSON.stringify(result)
  }
  text = text.replace(/\n/g, ' ').trim()
  if (text.length > 120) text = text.slice(0, 117) + '...'
  return text
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

export class ProgressReporter {
  private chatId: number
  private api: Api
  private messageId: number | null = null
  // Full process log: never evict — freeze the message and continue in a new one.
  private fullLog: boolean
  // message_ids of frozen (rolled-over) links — they persist in the chat as the log.
  private chainIds: number[] = []
  private lines: string[] = []
  private toolLines = new Map<string, number>()
  private toolNames = new Map<string, string>()
  private lastEditTime = 0
  private editTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private dirty = false
  private flushing = false
  private subagentTools = new Set<string>()
  private toolResults = new Map<string, string>() // tool_use_id -> result preview
  // Streaming text accumulator
  private streamingText = ''
  private streamingLineIdx: number | null = null
  private thinkingText = ''
  private thinkingLineIdx: number | null = null
  // Чи стрімилось мислення дельтами цього ходу (щоб не дублювати готовий блок)
  private thinkingStreamed = false
  // Index of the transient api_retry line, updated in place to avoid one line per retry
  private retryLineIdx: number | null = null
  private hasStreaming = false // true if stream_events are active (skip text in assistant)
  // Last cleared streaming text (for AskUser pre-message)
  private _lastClearedStreamingText = ''
  private cleanupDelayMs: number
  private cuteMode: boolean
  private t: BotT
  // Rich Message draft streaming (Bot API 10.1) — ефемерний preview відповіді
  private richDraft: boolean
  private draftId: number
  private draftDisabled = false
  private draftTimer: ReturnType<typeof setTimeout> | null = null
  private lastDraftTime = 0
  private lastDraftText = ''

  private draftThrottleMs: number

  constructor(chatId: number, api: Api, cleanupDelayMs?: number, cuteMode?: boolean, lang?: BotLang, richDraft?: boolean, fullLog?: boolean, draftThrottleMs?: number) {
    this.chatId = chatId
    this.api = api
    this.cleanupDelayMs = cleanupDelayMs ?? DEFAULT_CLEANUP_DELAY_MS
    this.cuteMode = cuteMode ?? false
    this.t = createBotT(lang ?? 'uk')
    this.richDraft = richDraft ?? false
    this.fullLog = fullLog ?? false
    // Повільніший тротлінг чернеток: швидкі оновлення крашили десктопні клієнти
    this.draftThrottleMs = Math.max(1000, draftThrottleMs ?? 2000)
    // draft_id має бути ненульовим і стабільним у межах одного ходу
    this.draftId = Math.floor(Math.random() * 2_000_000_000) + 1
  }

  handleEvent = (event: SDKMessage): void => {
    if (this.stopped) return

    const changed = this.formatEvent(event)
    if (!changed) return

    this.dirty = true
    this.scheduleFlush()
  }

  /** Add a follow-up marker and reset state for next agent run */
  addFollowupMarker(message: string): void {
    this.clearStreamingLine()
    this.hasStreaming = false
    this.retryLineIdx = null // new turn — don't reuse a previous turn's retry line
    this.thinkingText = ''
    this.thinkingLineIdx = null
    const preview = message.replace(/\n/g, ' ').trim().slice(0, 100)
    this.addLine(`\n💬 <b>→ ${escapeHtml(preview)}${message.length > 100 ? '...' : ''}</b>`)
    this.dirty = true
    this.scheduleFlush()
  }

  /** Get and clear the last streaming text that was cleared before a tool call.
   *  Used by AskUser to send context message before the question. */
  getAndClearPendingText(): string {
    const text = this._lastClearedStreamingText
    this._lastClearedStreamingText = ''
    return text
  }

  /** Freeze: stop updating, remove Stop button, keep message forever */
  async freeze(): Promise<void> {
    this.stopped = true
    if (this.editTimer) {
      clearTimeout(this.editTimer)
      this.editTimer = null
    }
    if (this.draftTimer) {
      clearTimeout(this.draftTimer)
      this.draftTimer = null
    }
    if (!this.messageId) return
    const msgId = this.messageId
    this.messageId = null
    try {
      const finalText = this.buildDisplayText()
      await this.api.editMessageText(this.chatId, msgId, finalText, {
        parse_mode: 'HTML',
      })
    } catch { /* ignore */ }
  }

  async cleanup(): Promise<void> {
    this.stopped = true
    if (this.editTimer) {
      clearTimeout(this.editTimer)
      this.editTimer = null
    }
    if (this.draftTimer) {
      clearTimeout(this.draftTimer)
      this.draftTimer = null
    }

    if (!this.messageId) return

    const msgId = this.messageId
    this.messageId = null

    // Remove the Stop button immediately, show final state with expandable details
    try {
      const finalText = this.buildDisplayText()
      await this.api.editMessageText(this.chatId, msgId, finalText, {
        parse_mode: 'HTML',
        // no reply_markup = removes keyboard
      })
    } catch { /* ignore */ }

    // Delete after delay (0 = immediate, Infinity = never)
    if (this.cleanupDelayMs === Infinity) return
    if (this.cleanupDelayMs === 0) {
      try { await this.api.deleteMessage(this.chatId, msgId) } catch { /* ignore */ }
      return
    }
    setTimeout(async () => {
      try {
        await this.api.deleteMessage(this.chatId, msgId)
      } catch {
        await new Promise(r => setTimeout(r, 500))
        try {
          await this.api.deleteMessage(this.chatId, msgId)
        } catch { /* give up */ }
      }
    }, this.cleanupDelayMs)
  }

  private formatEvent(event: SDKMessage): boolean {
    const isSubagent = 'parent_tool_use_id' in event && event.parent_tool_use_id != null
    const indent = isSubagent ? '  ' : ''

    // --- Assistant message: tool calls and text blocks ---
    if (event.type === 'assistant') {
      const msg = event.message
      if (!msg?.content) return false
      let hadContent = false

      // Check for assistant-level errors (rate limit, auth, billing)
      if ('error' in event && event.error) {
        const err = event.error as { type?: string; message?: string }
        const errorType = err.type ?? 'unknown'
        const errorLabels: Record<string, string> = this.cuteMode
          ? { rate_limit: this.t('progress.cute.rateLimit'), billing_error: this.t('progress.cute.billing'), authentication_failed: this.t('progress.cute.authError'), server_error: this.t('progress.cute.serverError') }
          : { rate_limit: this.t('progress.rateLimit'), billing_error: this.t('progress.billing'), authentication_failed: this.t('progress.authError'), server_error: this.t('progress.serverError') }
        this.addLine(errorLabels[errorType] ?? `⚠️ ${errorType}`)
        return true
      }

      for (const block of msg.content as any[]) {
        if (block.type === 'tool_use') {
          // Clear streaming text when a tool call starts
          this.clearStreamingLine()

          const name = block.name as string
          if (isHiddenTool(name)) continue
          const input = (block.input ?? {}) as Record<string, unknown>
          const detail = toolDetail(name, input)
          const idx = this.lines.length
          this.toolLines.set(block.id, idx)
          this.toolNames.set(block.id, name)
          if (name === 'Agent') this.subagentTools.add(block.id)
          const detailStr = detail ? ` ${escapeHtml(detail)}` : ''
          if (this.cuteMode) {
            const cuteToolKeys: Record<string, string> = {
              Read: 'progress.cute.read', Write: 'progress.cute.write', Edit: 'progress.cute.edit',
              Glob: 'progress.cute.glob', Grep: 'progress.cute.grep', Bash: 'progress.cute.bash',
              WebSearch: 'progress.cute.websearch', WebFetch: 'progress.cute.webfetch',
              Agent: 'progress.cute.agent', TodoWrite: 'progress.cute.todowrite',
              TodoRead: 'progress.cute.todoread', NotebookEdit: 'progress.cute.notebookedit',
              Skill: 'progress.cute.skill',
              AskGemini: 'progress.cute.askgemini', GeminiSearch: 'progress.cute.geminisearch',
              // Builtin tools
              GenerateImage: 'progress.cute.generateimage', EditImage: 'progress.cute.editimage',
              TextToSpeech: 'progress.cute.texttospeech', SendMedia: 'progress.cute.sendmedia',
              SetReaction: 'progress.cute.setreaction', ForwardMessage: 'progress.cute.forwardmessage',
              PublishTelegraph: 'progress.cute.publishtelegraph', ShareFile: 'progress.cute.sharefile',
              ListGalleryImages: 'progress.cute.gallery', SendGalleryImage: 'progress.cute.gallery',
              DeleteGalleryImage: 'progress.cute.gallery',
              CreateBackup: 'progress.cute.backup', ListBackups: 'progress.cute.backup',
              VerifyBackup: 'progress.cute.backup', RestoreBackup: 'progress.cute.backup',
              DeleteBackup: 'progress.cute.backup',
              SendEmail: 'progress.cute.sendemail',
              SaveFact: 'progress.cute.savefact', SearchMemory: 'progress.cute.searchmemory',
              DeleteFact: 'progress.cute.deletefact',
              CreateBot: 'progress.cute.botmanage', DeleteBot: 'progress.cute.botmanage',
              ListBots: 'progress.cute.botmanage',
              CurrencyRates: 'progress.cute.currencyrates', GetCurrentTime: 'progress.cute.getcurrenttime',
              CreateReminder: 'progress.cute.reminder', ListReminders: 'progress.cute.reminder',
              DeleteReminder: 'progress.cute.reminder',
              RunPython: 'progress.cute.runpython', AskUser: 'progress.cute.askuser',
              TakeScreenshot: 'progress.cute.takescreenshot', NameSession: 'progress.cute.namesession',
              ReadWorkspaceFile: 'progress.cute.workspacefile', WriteWorkspaceFile: 'progress.cute.workspacefile',
            }
            const cuteMcpKeys: Record<string, string> = {
              'bitrix24': 'progress.cute.bitrix24', 'home-assistant': 'progress.cute.homeassistant',
              'stagehand': 'progress.cute.stagehand', 'playwright': 'progress.cute.playwright',
              'macos-control': 'progress.cute.macoscontrol', 'google-workspace': 'progress.cute.googleworkspace',
              'meta-ads': 'progress.cute.metaads', 'notion': 'progress.cute.notion',
              'pubmed': 'progress.cute.pubmed', 'medical': 'progress.cute.medical',
              'spacedome': 'progress.cute.spacedome', 'freecad': 'progress.cute.freecad',
              'miro': 'progress.cute.miro',
            }
            const sn = shortToolName(name)
            let cute = cuteToolKeys[sn] ? this.t(cuteToolKeys[sn]) : undefined
            if (!cute) {
              const mcpPrefix = Object.keys(cuteMcpKeys).find(p => name.includes(p))
              cute = mcpPrefix ? this.t(cuteMcpKeys[mcpPrefix]) : this.t('progress.cute.default')
            }
            this.addLine(`<code>${indent}${cute}${detailStr}</code>`)
          } else {
            this.addLine(`<code>${indent}${toolIcon(name)} ${escapeHtml(shortToolName(name))}${detailStr}</code>`)
          }
          hadContent = true
        } else if (block.type === 'thinking' && (block as any).thinking) {
          // Готовий thinking-блок (коли дельти не стрімились цього ходу)
          if (!this.thinkingStreamed) {
            this.setThinkingLine(String((block as any).thinking))
            hadContent = true
          }
          // Хід завершено — наступне мислення піде новим 🧠-блоком у лозі
          this.thinkingStreamed = false
          this.thinkingText = ''
          this.thinkingLineIdx = null
        } else if (block.type === 'text' && block.text) {
          // Skip text blocks if streaming already showed them
          if (this.hasStreaming) continue
          const text = (block.text as string).replace(/\n/g, ' ').trim()
          if (text.length > 0) {
            const preview = text.slice(0, TEXT_PREVIEW_LEN)
            this.addLine(`<blockquote>${indent}💬 <i>${mdToHtml(preview)}${text.length > TEXT_PREVIEW_LEN ? '...' : ''}</i></blockquote>`)
            hadContent = true
          }
        }
      }
      return hadContent
    }

    // --- Streaming: partial text (token-by-token) ---
    if (event.type === 'stream_event') {
      const raw = event as any
      const streamEvent = raw.event
      if (!streamEvent) return false

      // Мислення агента: стрімимо повний процес розгорнутим блоком (🧠)
      if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'thinking_delta') {
        const chunk = streamEvent.delta.thinking ?? ''
        if (!chunk) return false
        this.thinkingText += chunk
        this.thinkingStreamed = true
        this.setThinkingLine(this.thinkingText)
        return true
      }

      if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
        const chunk = streamEvent.delta.text ?? ''
        if (!chunk) return false

        this.hasStreaming = true
        this.streamingText += chunk
        // Стрімимо ефемерну Rich-чернетку з часткової відповіді (тільки приватні чати)
        this.scheduleDraftFlush()
        const streamLine = this.streamLineString(indent)
        if (this.streamingLineIdx !== null && this.streamingLineIdx < this.lines.length) {
          this.lines[this.streamingLineIdx] = streamLine
        } else {
          this.streamingLineIdx = this.lines.length
          this.addLine(streamLine)
        }
        return true
      }

      // content_block_stop: finalize streaming
      if (streamEvent.type === 'content_block_stop') {
        // Мислення ходу завершилось — заморожуємо його рядок; наступний хід
        // почне новий 🧠-блок, щоб у повному лозі було мислення КОЖНОГО ходу
        if (this.thinkingText.trim().length > 0) {
          this.thinkingText = ''
          this.thinkingLineIdx = null
        }
        this.clearStreamingLine()
        return false
      }

      return false
    }

    // --- Tool progress (elapsed time) ---
    if (event.type === 'tool_progress') {
      const elapsed = Math.round(event.elapsed_time_seconds)
      const idx = this.toolLines.get(event.tool_use_id)
      if (idx !== undefined && idx < this.lines.length) {
        const original = this.lines[idx]
        // Strip trailing </code>, previous time, then re-add
        const stripped = original.replace(/<\/code>$/, '').replace(/\s*\(\d+s\)$/, '')
        this.lines[idx] = stripped.replace(TOOL_ICON_RE, '$1$2⏳') + ` (${elapsed}s)</code>`
      }
      return true
    }

    // --- Tool result ---
    if (event.type === 'user' && event.tool_use_result !== undefined) {
      if (event.parent_tool_use_id) {
        const idx = this.toolLines.get(event.parent_tool_use_id)
        const toolName = this.toolNames.get(event.parent_tool_use_id)
        if (idx !== undefined && idx < this.lines.length) {
          // Strip </code> before modifications, re-add after
          let line = this.lines[idx].replace(/<\/code>$/, '')
          line = line
            .replace(TOOL_ICON_RE, '$1$2✅')
            .replace(/\s*\(\d+s\)$/g, '')

          if (toolName && !this.subagentTools.has(event.parent_tool_use_id)) {
            const preview = resultPreview(event.tool_use_result)
            if (preview) {
              const shortPreview = preview.length > 60 ? preview.slice(0, 57) + '...' : preview
              line += ` → ${escapeHtml(shortPreview)}`
              this.toolResults.set(event.parent_tool_use_id, preview)
            }
          }
          this.lines[idx] = line + '</code>'
        }
      }
      return true
    }

    // --- Auth status (MCP authentication) ---
    if (event.type === 'auth_status') {
      const auth = event as any
      if (auth.isAuthenticating) {
        if (this.cuteMode) {
          this.addLine(`<i>${this.t('progress.cute.auth')}</i>`)
        } else {
          const output = (auth.output ?? []) as string[]
          const lastLine = output[output.length - 1] ?? this.t('progress.auth')
          this.addLine(`🔐 <i>${escapeHtml(lastLine.slice(0, 80))}</i>`)
        }
      } else if (auth.error) {
        this.addLine(this.cuteMode ? `<i>${this.t('progress.cute.authFail')}</i>` : `🔐 ❌ <i>${escapeHtml(String(auth.error).slice(0, 80))}</i>`)
      }
      return true
    }

    // --- System events ---
    if (event.type === 'system') {
      const sys = event as any

      // Compacting
      // Redacted-фаза мислення: текст ще не стрімиться, показуємо живий лічильник
      if (sys.subtype === 'thinking_tokens') {
        if (this.thinkingText.length > 0) return false
        const tok = Number(sys.estimated_tokens ?? 0)
        const line = `<blockquote>🧠 <i>${this.cuteMode ? 'думає-думає' : 'думає'}… ~${tok} ток.</i></blockquote>`
        if (this.thinkingLineIdx !== null && this.thinkingLineIdx < this.lines.length) {
          this.lines[this.thinkingLineIdx] = line
        } else {
          this.thinkingLineIdx = this.lines.length
          this.addLine(line)
        }
        return true
      }

      if (sys.subtype === 'status' && sys.status === 'compacting') {
        this.addLine(this.cuteMode ? `<i>${this.t('progress.cute.compacting')}</i>` : this.t('progress.compacting'))
        return true
      }

      // Compact boundary: show how much was compressed
      if (sys.subtype === 'compact_boundary') {
        const pre = sys.compact_metadata?.pre_tokens
        if (pre) {
          if (this.cuteMode) {
            this.addLine(`<i>${this.t('progress.cute.compacted')}</i>`)
          } else {
            const k = pre >= 1000 ? `${(pre / 1000).toFixed(0)}k` : String(pre)
            this.addLine(this.t('progress.compacted', { k }))
          }
        }
        return true
      }

      // Hook response
      if (sys.subtype === 'hook_response') {
        if (sys.exit_code && sys.exit_code !== 0) {
          this.addLine(this.cuteMode ? `<i>${this.t('progress.cute.hookFail')}</i>` : `⚙️ hook <b>${escapeHtml(sys.hook_name ?? '')}</b> failed (exit ${sys.exit_code})`)
          return true
        }
      }

      // Model fallback: primary model overloaded/refused → swapped to a lower tier.
      // (SDKModelRefusalFallbackMessage is the only "switched fallback model" signal
      // this SDK emits; the overload/rate-limit distinction lives on api_retry below.)
      if (sys.subtype === 'model_refusal_fallback' && sys.direction === 'retry') {
        const fallback = String(sys.fallback_model ?? '')
        this.addLine(this.cuteMode
          ? `<i>${this.t('progress.cute.modelFallback')}</i>`
          : this.t('progress.modelFallback', { model: escapeHtml(fallback) }))
        return true
      }

      // API retry: overloaded (529) or rate_limit (429). Update one line in place
      // instead of appending a fresh line per retry.
      if (sys.subtype === 'api_retry') {
        const attempt = Number(sys.attempt ?? 0)
        const max = Number(sys.max_retries ?? 0)
        const key = sys.error === 'rate_limit' ? 'progress.apiRetryRateLimit' : 'progress.apiRetryOverloaded'
        const line = this.cuteMode
          ? `<i>${this.t('progress.cute.rateLimit')}</i>`
          : this.t(key, { n: attempt, m: max })
        if (this.retryLineIdx !== null && this.retryLineIdx < this.lines.length) {
          this.lines[this.retryLineIdx] = line
        } else {
          this.retryLineIdx = this.lines.length
          this.addLine(line)
        }
        return true
      }

      // Init: skip — same every message, just noise
    }

    // --- Tool use summary (multi-tool batch) ---
    if (event.type === 'tool_use_summary') {
      const summary = (event as any).summary as string
      if (summary) {
        const preview = summary.replace(/\n/g, ' ').trim().slice(0, TEXT_PREVIEW_LEN)
        this.addLine(`📋 <i>${mdToHtml(preview)}${summary.length > TEXT_PREVIEW_LEN ? '...' : ''}</i>`)
        return true
      }
      return false
    }

    // --- Rate limit events ---
    if (event.type === 'rate_limit_event') {
      const info = (event as any).rate_limit_info
      if (info?.status === 'rejected') {
        const resetsAt = info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : '?'
        this.addLine(this.cuteMode
          ? `<i>${this.t('progress.cute.rateLimit')}</i>`
          : `⏳ <i>Rate limit — reset ${escapeHtml(resetsAt)}</i>`)
        return true
      }
      if (info?.status === 'allowed_warning') {
        this.addLine(this.cuteMode
          ? `<i>${this.t('progress.cute.rateLimit')}</i>`
          : `⚠️ <i>Rate limit warning (${Math.round((info.utilization ?? 0) * 100)}%)</i>`)
        return true
      }
      return false
    }

    // --- Task (subagent) events ---
    if (event.type === 'system') {
      const sys = event as any

      if (sys.subtype === 'task_started') {
        const desc = (sys.description ?? '').slice(0, 60)
        this.addLine(`  🤖 <i>Subtask: ${escapeHtml(desc)}</i>`)
        return true
      }

      if (sys.subtype === 'task_progress' && sys.summary) {
        const summary = String(sys.summary).replace(/\n/g, ' ').trim().slice(0, 80)
        this.addLine(`  💭 <i>${escapeHtml(summary)}</i>`)
        return true
      }

      if (sys.subtype === 'task_notification') {
        const status = sys.status === 'completed' ? '✅' : sys.status === 'failed' ? '❌' : '⏹'
        const summary = sys.summary ? `: ${String(sys.summary).replace(/\n/g, ' ').trim().slice(0, 60)}` : ''
        this.addLine(`  ${status} <i>Subtask ${sys.status ?? 'done'}${escapeHtml(summary)}</i>`)
        return true
      }

      // Hook events — debug only, don't show in Telegram
      if (sys.subtype === 'hook_started' || sys.subtype === 'hook_progress') {
        logger.debug({ hook: sys.hook_name, subtype: sys.subtype }, 'Hook event')
        return false
      }

      // Files persisted — debug only
      if (sys.subtype === 'files_persisted') {
        logger.debug({ files: (sys.files ?? []).length, failed: (sys.failed ?? []).length }, 'Files persisted')
        return false
      }
    }

    // --- Prompt suggestion, local_command_output, elicitation_complete — ignore ---
    const eventType = event.type as string
    if (eventType === 'prompt_suggestion' || eventType === 'local_command_output' || eventType === 'elicitation_complete') {
      return false
    }

    // --- Result: show summary line ---
    if (event.type === 'result') {
      const res = event as any
      if (this.cuteMode) {
        // Simple cute summary
        if (res.duration_ms) {
          const dur = formatDuration(res.duration_ms)
          this.addLine(`<i>${this.t('progress.doneIn', { duration: dur })}</i>`)
        } else {
          this.addLine(`<i>${this.t('progress.done')}</i>`)
        }
        return true
      }
      const parts: string[] = []

      if (res.duration_ms) parts.push(`⏱ ${formatDuration(res.duration_ms)}`)
      if (res.num_turns) parts.push(`${res.num_turns} turns`)

      // Permission denials
      const denials = (res.permission_denials ?? []) as { tool?: string }[]
      if (denials.length > 0) {
        const tools = denials.map(d => d.tool ?? '?').join(', ')
        parts.push(`🚫 blocked: ${tools}`)
      }

      if (res.subtype !== 'success' && res.subtype !== undefined) {
        // Перерваний користувачем хід (Stop/follow-up) — не помилка, а зупинка
        if (res.subtype === 'error_during_execution' && isInterrupted(String(this.chatId))) {
          parts.push('⏹ зупинено')
        } else {
          parts.push(`⚠️ ${res.subtype}`)
        }
      }

      if (parts.length > 0) {
        this.addLine(`<i>${escapeHtml(parts.join(' | '))}</i>`)
        return true
      }
    }

    return false
  }

  /** Рядок трансляції мислення: розгорнутий blockquote з хвостом процесу (🧠) */
  private thinkingLineString(text: string): string {
    const display = text.trim()
    const preview = display.length > THINKING_PREVIEW_LEN
      ? '...' + display.slice(-(THINKING_PREVIEW_LEN - 3))
      : display
    return `<blockquote>🧠 <i>${escapeHtml(preview)}</i></blockquote>`
  }

  /** Рядок стрімінгу відповіді: expandable blockquote з хвостом тексту (✍️/💭) */
  private streamLineString(indent = ''): string {
    const display = this.streamingText.replace(/\n/g, ' ').trim()
    const preview = display.length > STREAM_PREVIEW_LEN
      ? '...' + display.slice(-(STREAM_PREVIEW_LEN - 3))
      : display
    const streamEmoji = this.cuteMode ? '💭' : '✍️'
    return `<blockquote expandable>${indent}${streamEmoji} <i>${mdToHtml(preview)}</i></blockquote>`
  }

  /** Оновити/додати рядок трансляції мислення (повністю розгорнутий blockquote) */
  private setThinkingLine(text: string): void {
    if (text.trim().length === 0) return
    const line = this.thinkingLineString(text)
    if (this.thinkingLineIdx !== null && this.thinkingLineIdx < this.lines.length) {
      this.lines[this.thinkingLineIdx] = line
    } else {
      this.thinkingLineIdx = this.lines.length
      this.addLine(line)
    }
  }

  private clearStreamingLine(): void {
    // Save streaming text for AskUser pre-message
    const trimmed = this.streamingText.trim()
    if (trimmed.length > 0) {
      this._lastClearedStreamingText = trimmed
    }

    if (this.streamingLineIdx !== null && this.streamingLineIdx < this.lines.length) {
      // Replace streaming preview with final text block
      const display = this.streamingText.replace(/\n/g, ' ').trim()
      if (display.length > 0) {
        // У повному лозі зберігаємо суттєво довший слід кожного ходу
        const cap = this.fullLog ? STREAM_PREVIEW_LEN : TEXT_PREVIEW_LEN
        const preview = display.slice(0, cap)
        this.lines[this.streamingLineIdx] = `<blockquote>💬 <i>${mdToHtml(preview)}${display.length > cap ? '...' : ''}</i></blockquote>`
      } else {
        this.lines.splice(this.streamingLineIdx, 1)
        // Fix indexes
        for (const [id, idx] of this.toolLines) {
          if (idx >= this.streamingLineIdx) {
            this.toolLines.set(id, idx - 1)
          }
        }
      }
    }
    this.streamingText = ''
    this.streamingLineIdx = null
  }

  private addLine(line: string): void {
    this.lines.push(line)
    // Full-log mode never evicts — rollover (at flush time) bounds the message.
    if (this.fullLog) return
    while (this.lines.length > MAX_LINES) {
      this.lines.shift()
      // Fix streaming line index
      if (this.streamingLineIdx !== null) {
        this.streamingLineIdx--
        if (this.streamingLineIdx < 0) this.streamingLineIdx = null
      }
      if (this.thinkingLineIdx !== null) {
        this.thinkingLineIdx--
        if (this.thinkingLineIdx < 0) this.thinkingLineIdx = null
      }
      if (this.retryLineIdx !== null) {
        this.retryLineIdx--
        if (this.retryLineIdx < 0) this.retryLineIdx = null
      }
      for (const [id, idx] of this.toolLines) {
        if (idx <= 0) {
          this.toolLines.delete(id)
        } else {
          this.toolLines.set(id, idx - 1)
        }
      }
    }
  }

  /** Build display text: chronological order, active streaming line always last */
  private buildDisplayText(): string {
    const parts: string[] = []
    for (let i = 0; i < this.lines.length; i++) {
      if (i === this.streamingLineIdx) continue
      parts.push(this.lines[i])
    }
    if (this.streamingLineIdx !== null && this.streamingLineIdx < this.lines.length) {
      parts.push(this.lines[this.streamingLineIdx])
    }
    return parts.join('\n') || '...'
  }

  /** Заплановане (throttled) надсилання Rich-чернетки під час стрімінгу. */
  private scheduleDraftFlush(): void {
    if (!this.richDraft || this.draftDisabled || this.stopped) return
    if (this.draftTimer) return
    const elapsed = Date.now() - this.lastDraftTime
    const delay = Math.max(0, this.draftThrottleMs - elapsed)
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null
      this.flushDraft().catch(() => {})
    }, delay)
  }

  private async flushDraft(): Promise<void> {
    if (this.draftDisabled || this.stopped) return
    const partial = this.streamingText.trim()
    if (!partial) return
    // Блочні оновлення замість потоку: клієнт анімує зміни чернетки з тим самим
    // draft_id ПОБУКВЕНО, і ця анімація крашить десктопні клієнти (07.2026).
    // Тому: (1) шлемо лише до останньої завершеної межі (абзац або речення),
    // (2) щоразу з НОВИМ draft_id — заміна блоку миттєва, без анімації.
    const boundary = Math.max(
      partial.lastIndexOf('\n\n'),
      partial.lastIndexOf('. '),
      partial.lastIndexOf('.\n'),
    )
    if (boundary < 1) return // ще немає завершеного блоку
    const chunk = partial.slice(0, boundary + 1)
    if (chunk === this.lastDraftText) return
    this.lastDraftText = chunk
    try {
      this.draftId = Math.floor(Math.random() * 2_000_000_000) + 1
      await this.api.sendRichMessageDraft(this.chatId, this.draftId, draftRichMessage(chunk))
      this.lastDraftTime = Date.now()
    } catch (err) {
      // Помилка чернетки не критична — вимикаємо стрімінг чернеток на цей хід
      this.draftDisabled = true
      logger.warn({ err }, 'Rich draft streaming disabled for this turn')
    }
  }

  private scheduleFlush(): void {
    if (this.editTimer) return

    const elapsed = Date.now() - this.lastEditTime
    const delay = Math.max(0, THROTTLE_MS - elapsed)

    this.editTimer = setTimeout(() => {
      this.editTimer = null
      this.flush().catch(err => logger.debug({ err }, 'Progress flush failed'))
    }, delay)
  }

  /** Build the Stop / Interrupt inline keyboard for the active progress message. */
  private buildKeyboard(): InlineKeyboard {
    const stopLabel = this.cuteMode ? this.t('progress.cute.stop') : this.t('progress.stop')
    const interruptLabel = this.cuteMode ? this.t('progress.cute.interrupt') : this.t('progress.interrupt')
    // Two buttons side-by-side: soft Stop (ESC — keeps partial) + hard Interrupt (kills process)
    return new InlineKeyboard()
      .text(stopLabel, `stop:${this.chatId}`)
      .text(interruptLabel, `intr:${this.chatId}`)
  }

  /** Full-log: does the current message need to roll over into a fresh link? */
  private shouldRollover(): boolean {
    if (!this.fullLog || !this.messageId) return false
    if (this.lines.length > MAX_LINES_FULL) return true
    return this.buildDisplayText().length > ROLLOVER_CHARS
  }

  /**
   * Freeze the current message and continue the log in a new linked message.
   * Sends the new link FIRST (with the current, up-to-date content + buttons);
   * only on success does it strip the old message's buttons and archive it.
   * If the send fails we keep editing the old message. Active streaming/thinking
   * migrate into the new link (their tails continue there); the frozen message
   * keeps the last rendered snapshot of everything before the rollover.
   * @returns true if the rollover happened (new link already sent).
   */
  private async rollover(keyboard: InlineKeyboard): Promise<boolean> {
    const oldId = this.messageId
    if (oldId === null) return false
    const snapshot = this.buildDisplayText()

    // Build the migrated state for the new link without committing it yet.
    const newLines: string[] = []
    let newThinkingIdx: number | null = null
    let newStreamingIdx: number | null = null
    if (this.thinkingLineIdx !== null && this.thinkingText.trim().length > 0) {
      newThinkingIdx = newLines.length
      newLines.push(this.thinkingLineString(this.thinkingText))
    }
    if (this.streamingLineIdx !== null && this.streamingText.trim().length > 0) {
      newStreamingIdx = newLines.length
      newLines.push(this.streamLineString())
    }
    const newText = newLines.join('\n') || '...'

    let sent
    try {
      sent = await this.api.sendMessage(this.chatId, newText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
    } catch (err) {
      // New link failed — keep the old message (with its buttons) as the live one.
      logger.debug({ err }, 'Progress rollover: new link send failed, keeping old message')
      return false
    }

    // New link is live → freeze the old one (final edit, no reply_markup = buttons gone).
    try {
      await this.api.editMessageText(this.chatId, oldId, snapshot, { parse_mode: 'HTML' })
    } catch { /* ignore — the old message keeps whatever it last showed */ }
    this.chainIds.push(oldId)

    // Commit the migrated state. Old tool references belong to the frozen snapshot.
    this.lines = newLines
    this.toolLines.clear()
    this.toolNames.clear()
    this.subagentTools.clear()
    this.retryLineIdx = null
    this.thinkingLineIdx = newThinkingIdx
    this.streamingLineIdx = newStreamingIdx
    this.messageId = sent.message_id
    this.lastEditTime = Date.now()
    return true
  }

  private async flush(): Promise<void> {
    if (this.stopped || !this.dirty || this.flushing) return
    this.flushing = true
    this.dirty = false

    const keyboard = this.buildKeyboard()

    try {
      if (this.stopped) return

      // Full-log: freeze the current message and continue in a fresh link. The
      // rollover already sends the new link with current content — nothing more
      // to do this cycle.
      if (this.shouldRollover()) {
        const rolled = await this.rollover(keyboard)
        if (rolled) return
      }

      const text = this.buildDisplayText()
      if (!this.messageId) {
        const sent = await this.api.sendMessage(this.chatId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
        if (this.stopped) {
          // Already stopped — remove button, schedule delayed delete
          try {
            await this.api.editMessageText(this.chatId, sent.message_id, text, { parse_mode: 'HTML' })
          } catch { /* ignore */ }
          if (this.cleanupDelayMs !== Infinity) {
            if (this.cleanupDelayMs === 0) {
              this.api.deleteMessage(this.chatId, sent.message_id).catch(() => {})
            } else {
              setTimeout(() => {
                this.api.deleteMessage(this.chatId, sent.message_id).catch(() => {})
              }, this.cleanupDelayMs)
            }
          }
        } else {
          this.messageId = sent.message_id
        }
      } else {
        await this.api.editMessageText(this.chatId, this.messageId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
      }
      this.lastEditTime = Date.now()
    } catch (err: any) {
      if (!err?.description?.includes('message is not modified')) {
        logger.debug({ err }, 'Progress edit failed')
      }
    } finally {
      this.flushing = false
    }
  }
}
