import type { Api } from 'grammy'
import { InlineKeyboard } from 'grammy'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { logger } from './logger.js'
import { createBotT, type BotLang, type BotT } from './bot-i18n.js'

const THROTTLE_MS = 1500
const MAX_LINES = 20
const TEXT_PREVIEW_LEN = 200
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

// Cute Ukrainian tool names for "blonde" mode
const CUTE_TOOL_NAMES: Record<string, string> = {
  Read: '📖 читаємо файлик',
  Write: '✏️ пишемо файлик',
  Edit: '💅 міняємо буквочки',
  Glob: '🔍 шукаємо файлики',
  Grep: '👀 продивляємось папочки',
  Bash: '⚡ запускаємо команду',
  WebSearch: '🌐 гуглимо',
  WebFetch: '📥 завантажуємо сторіночку',
  Agent: '🤖 помічник думає',
  TodoWrite: '📝 записуємо задачку',
  TodoRead: '📋 дивимось задачки',
  NotebookEdit: '📓 редагуємо зошит',
  Skill: '✨ використовуємо скіл',
}

// Cute status messages for "blonde" mode
const CUTE_STATUSES: Record<string, string> = {
  compacting: '🧹 прибираємо в голові...',
  compacted: '🧹 прибрали в голові',
  auth: '🔑 авторизуємось...',
  authFail: '🔑 ой, не пустили',
  hookFail: '⚙️ ой, щось зламалось',
  rateLimit: '⏳ трішки зачекаємо...',
  billing: '💳 ой, з оплатою щось',
  authError: '🔑 не вдалось увійти',
  serverError: '🔥 серверу поганенько',
  working: '⏳ працюємо',
  done: '✅ зробили!',
}

// Cute MCP tool name prefixes for "blonde" mode
const CUTE_MCP_PREFIXES: Record<string, string> = {
  'bitrix24': '📋 дивимось CRM',
  'home-assistant': '🏠 керуємо будинком',
  'stagehand': '🎭 керуємо браузером',
  'playwright': '🎭 керуємо браузером',
  'macos-control': '🖥️ керуємо маком',
  'google-workspace': '📧 дивимось пошту',
  'meta-ads': '📣 крутимо рекламку',
  'notion': '📔 гортаємо нотатки',
  'pubmed': '🔬 читаємо наукове',
  'medical': '💊 дивимось пігулочки',
  'spacedome': '⛺ будуємо купол',
  'freecad': '📐 малюємо фігурки',
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
}

function toolIcon(name: string): string {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name]
  const mcpPrefix = Object.keys(MCP_ICONS).find(p => name.startsWith(p + '_'))
  return mcpPrefix ? MCP_ICONS[mcpPrefix] : '🔧'
}

// Regex matching any tool icon (for replacement in progress/result)
const TOOL_ICON_RE = /^(\s*)[📖✏️✂️🔍👀⚡🌐📥🤖📝📋📓✨🔧⏳✅🏠🎭🖥️📧📣📔🔬💊⛺📐][\uFE0F]?/

function toolDetail(name: string, input: Record<string, unknown>): string {
  const i = input
  switch (name) {
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
  private hasStreaming = false // true if stream_events are active (skip text in assistant)
  private cleanupDelayMs: number
  private cuteMode: boolean
  private t: BotT

  constructor(chatId: number, api: Api, cleanupDelayMs?: number, cuteMode?: boolean, lang?: BotLang) {
    this.chatId = chatId
    this.api = api
    this.cleanupDelayMs = cleanupDelayMs ?? DEFAULT_CLEANUP_DELAY_MS
    this.cuteMode = cuteMode ?? false
    this.t = createBotT(lang ?? 'uk')
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
    const preview = message.replace(/\n/g, ' ').trim().slice(0, 100)
    this.addLine(`\n💬 <b>→ ${escapeHtml(preview)}${message.length > 100 ? '...' : ''}</b>`)
    this.dirty = true
    this.scheduleFlush()
  }

  /** Freeze: stop updating, remove Stop button, keep message forever */
  async freeze(): Promise<void> {
    this.stopped = true
    if (this.editTimer) {
      clearTimeout(this.editTimer)
      this.editTimer = null
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
          const input = (block.input ?? {}) as Record<string, unknown>
          const detail = toolDetail(name, input)
          const idx = this.lines.length
          this.toolLines.set(block.id, idx)
          this.toolNames.set(block.id, name)
          if (name === 'Agent') this.subagentTools.add(block.id)
          const detailStr = detail ? ` <code>${escapeHtml(detail)}</code>` : ''
          if (this.cuteMode) {
            const cuteToolKeys: Record<string, string> = {
              Read: 'progress.cute.read', Write: 'progress.cute.write', Edit: 'progress.cute.edit',
              Glob: 'progress.cute.glob', Grep: 'progress.cute.grep', Bash: 'progress.cute.bash',
              WebSearch: 'progress.cute.websearch', WebFetch: 'progress.cute.webfetch',
              Agent: 'progress.cute.agent', TodoWrite: 'progress.cute.todowrite',
              TodoRead: 'progress.cute.todoread', NotebookEdit: 'progress.cute.notebookedit',
              Skill: 'progress.cute.skill',
            }
            const cuteMcpKeys: Record<string, string> = {
              'bitrix24': 'progress.cute.bitrix24', 'home-assistant': 'progress.cute.homeassistant',
              'stagehand': 'progress.cute.stagehand', 'playwright': 'progress.cute.playwright',
              'macos-control': 'progress.cute.macoscontrol', 'google-workspace': 'progress.cute.googleworkspace',
              'meta-ads': 'progress.cute.metaads', 'notion': 'progress.cute.notion',
              'pubmed': 'progress.cute.pubmed', 'medical': 'progress.cute.medical',
              'spacedome': 'progress.cute.spacedome', 'freecad': 'progress.cute.freecad',
            }
            let cute = cuteToolKeys[name] ? this.t(cuteToolKeys[name]) : undefined
            if (!cute) {
              const mcpPrefix = Object.keys(cuteMcpKeys).find(p => name.startsWith(p + '_'))
              cute = mcpPrefix ? this.t(cuteMcpKeys[mcpPrefix]) : this.t('progress.cute.default')
            }
            this.addLine(`${indent}${cute}${detailStr}`)
          } else {
            this.addLine(`${indent}${toolIcon(name)} <b>${escapeHtml(name)}</b>${detailStr}`)
          }
          hadContent = true
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

      if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
        const chunk = streamEvent.delta.text ?? ''
        if (!chunk) return false

        this.hasStreaming = true
        this.streamingText += chunk
        // Show last 300 chars of streaming text
        const display = this.streamingText.replace(/\n/g, ' ').trim()
        const preview = display.length > 300 ? '...' + display.slice(-297) : display

        const streamEmoji = this.cuteMode ? '💭' : '✍️'
        const streamLine = `<blockquote>${indent}${streamEmoji} <i>${mdToHtml(preview)}</i></blockquote>`
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
        const withoutTime = original.replace(/\s*\(\d+s\)$/g, '')
        this.lines[idx] = withoutTime.replace(TOOL_ICON_RE, '$1⏳') + ` (${elapsed}s)`
      }
      return true
    }

    // --- Tool result ---
    if (event.type === 'user' && event.tool_use_result !== undefined) {
      if (event.parent_tool_use_id) {
        const idx = this.toolLines.get(event.parent_tool_use_id)
        const toolName = this.toolNames.get(event.parent_tool_use_id)
        if (idx !== undefined && idx < this.lines.length) {
          this.lines[idx] = this.lines[idx]
            .replace(TOOL_ICON_RE, '$1✅')
            .replace(/\s*\(\d+s\)$/g, '')

          if (toolName && !this.subagentTools.has(event.parent_tool_use_id)) {
            const preview = resultPreview(event.tool_use_result)
            if (preview) {
              // Inline short result on the same line as tool
              const shortPreview = preview.length > 60 ? preview.slice(0, 57) + '...' : preview
              this.lines[idx] += ` → <i>${escapeHtml(shortPreview)}</i>`
              // Also collect full result for final expandable blockquote
              this.toolResults.set(event.parent_tool_use_id, preview)
            }
          }
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
        parts.push(`⚠️ ${res.subtype}`)
      }

      if (parts.length > 0) {
        this.addLine(`<i>${escapeHtml(parts.join(' | '))}</i>`)
        return true
      }
    }

    return false
  }

  private clearStreamingLine(): void {
    if (this.streamingLineIdx !== null && this.streamingLineIdx < this.lines.length) {
      // Replace streaming preview with final text block
      const display = this.streamingText.replace(/\n/g, ' ').trim()
      if (display.length > 0) {
        const preview = display.slice(0, TEXT_PREVIEW_LEN)
        this.lines[this.streamingLineIdx] = `<blockquote>💬 <i>${mdToHtml(preview)}${display.length > TEXT_PREVIEW_LEN ? '...' : ''}</i></blockquote>`
      } else {
        this.lines.splice(this.streamingLineIdx, 1)
        // Fix indexes
        for (const [id, idx] of this.toolLines) {
          if (idx > this.streamingLineIdx) {
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
    while (this.lines.length > MAX_LINES) {
      this.lines.shift()
      // Fix streaming line index
      if (this.streamingLineIdx !== null) {
        this.streamingLineIdx--
        if (this.streamingLineIdx < 0) this.streamingLineIdx = null
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

  /** Build structured display text: streaming visible, tools in expandable blockquote */
  private buildDisplayText(): string {
    // Categorize lines: tools vs streaming vs other (system messages, errors, etc.)
    const toolIdxSet = new Set<number>()
    for (const idx of this.toolLines.values()) {
      toolIdxSet.add(idx)
    }

    const toolParts: string[] = []
    const otherParts: string[] = []
    let streamPart = ''

    for (let i = 0; i < this.lines.length; i++) {
      if (toolIdxSet.has(i)) {
        toolParts.push(this.lines[i])
      } else if (i === this.streamingLineIdx) {
        streamPart = this.lines[i]
      } else {
        otherParts.push(this.lines[i])
      }
    }

    const parts: string[] = []

    // Streaming text first (most important — what the bot is thinking)
    if (streamPart) parts.push(streamPart)

    // System messages (errors, compacting, auth, rate limit)
    if (otherParts.length) parts.push(otherParts.join('\n'))

    // Tools in expandable blockquote
    if (toolParts.length) {
      parts.push(`<blockquote expandable>${toolParts.join('\n')}</blockquote>`)
    }

    return parts.join('\n') || '...'
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

  private async flush(): Promise<void> {
    if (this.stopped || !this.dirty || this.flushing) return
    this.flushing = true
    this.dirty = false

    const text = this.buildDisplayText()
    const stopLabel = this.cuteMode ? this.t('progress.cute.stop') : this.t('progress.stop')
    const keyboard = new InlineKeyboard().text(stopLabel, `stop:${this.chatId}`)

    try {
      if (this.stopped) return
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
