import { existsSync, readFileSync, statSync } from 'fs'

/**
 * Deterministic JSONL session compactor.
 *
 * Converts a raw Claude Agent SDK `.jsonl` session file into a compact
 * structured form suitable for LLM consumption. Strips meta/overhead
 * (typically 65% of raw bytes), summarizes tool_use inputs and tool_result
 * outputs, and marks trivial sessions so the caller can skip the LLM entirely.
 *
 * Target compression ratio: 7–10× on real BotVa sessions.
 */

const THINKING_MAX = 300
const TOOL_RESULT_MAX = 200
const BASH_INPUT_MAX = 120
const GENERIC_INPUT_MAX = 200
const USER_TEXT_TRIVIAL_THRESHOLD = 80

/**
 * Tools whose presence makes a session non-trivial (a real decision happened).
 *
 * NOTE: `SaveFact`/`DeleteFact`/`BoostFact` are intentionally EXCLUDED — they
 * represent already-consolidated decisions (the bot saved a fact inline at the
 * user's request). A session where the only action is SaveFact has nothing
 * extra to consolidate. Those tools are still shown to the LLM via
 * FULL_INPUT_TOOLS so the consolidator can dedupe against existing facts.
 */
const MUTATING_TOOLS = new Set<string>([
  'Write',
  'Edit',
  'MultiEdit',
  'WriteWorkspaceFile',
  'CreateReminder',
  'DeleteReminder',
  'SendEmail',
  'GenerateImage',
  'EditImage',
  'TextToSpeech',
  'NameSession',
  'CreateBot',
  'DeleteBot',
  'CreateBackup',
  'RestoreBackup',
  'DeleteBackup',
  'PublishTelegraph',
])

/** Tools where the full input IS the decision (never truncate). */
const FULL_INPUT_TOOLS = new Set<string>([
  'SaveFact',
  'DeleteFact',
  'BoostFact',
  'CreateReminder',
  'DeleteReminder',
  'SendEmail',
  'NameSession',
])

export interface CompactTool {
  name: string
  input: string
  ok?: boolean
  result?: string
}

export interface CompactTurn {
  role: 'user' | 'assistant'
  text?: string
  thinking?: string
  tools?: CompactTool[]
}

export interface CompactStats {
  totalTurns: number
  toolCalls: number
  rawBytes: number
  compactedBytes: number
  trivial: boolean
}

export interface CompactedSession {
  turns: CompactTurn[]
  stats: CompactStats
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

function extractTextBlock(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text
    }
  }
  return ''
}

/** Detect if a Bash command is a mutating git operation (commit, push, etc.). */
function isMutatingBash(cmd: string): boolean {
  const m = cmd.match(/\bgit\s+(commit|push|merge|rebase|reset|checkout|tag|cherry-pick)\b/)
  return !!m
}

/** Produce a deterministic one-line summary of a tool_use input. */
function summarizeToolInput(name: string, input: unknown): string {
  if (input == null) return ''
  const raw = typeof input === 'string' ? input : (() => {
    try { return JSON.stringify(input) } catch { return String(input) }
  })()

  if (FULL_INPUT_TOOLS.has(name)) return raw

  if (typeof input === 'object' && input !== null) {
    const o = input as Record<string, unknown>
    if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'WriteWorkspaceFile' || name === 'ReadWorkspaceFile') {
      const fp = o.file_path ?? o.path ?? o.filename
      if (typeof fp === 'string') return `file_path=${fp}`
    }
    if (name === 'Bash') {
      const cmd = typeof o.command === 'string' ? o.command : raw
      return truncate(cmd, BASH_INPUT_MAX)
    }
    if (name === 'Read') {
      const fp = o.file_path
      if (typeof fp === 'string') return `file_path=${fp}`
    }
    if (name === 'Grep' || name === 'Glob') {
      const p = o.pattern ?? o.query
      if (typeof p === 'string') return `pattern=${truncate(p, 120)}`
    }
    if (name === 'SearchMemory') {
      const q = o.query
      if (typeof q === 'string') return `query=${truncate(q, 120)}`
    }
  }

  return truncate(raw, GENERIC_INPUT_MAX)
}

/** Summarize a tool_result payload to a short line (or error marker). */
function summarizeToolResult(content: unknown, isError: boolean): string {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    let items = 0
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      } else {
        items++
      }
    }
    text = parts.join('\n')
    if (!text && items > 0) return `[${items} items]`
  } else if (content != null) {
    try { text = JSON.stringify(content) } catch { text = String(content) }
  }
  text = text.trim()
  if (isError) return `[error: ${truncate(text, TOOL_RESULT_MAX)}]`
  if (!text) return ''
  return truncate(text, TOOL_RESULT_MAX)
}

/** Strip injected memory/diary context blocks from user messages. */
function stripInjectedContext(text: string): string {
  return text
    .replace(/^\[Щоденник[\s\S]*?\]\s*\n\n/m, '')
    .replace(/^\[Memory context\][\s\S]*?\n\n/m, '')
    .replace(/^\[Short-term context\][\s\S]*?\n\n/m, '')
    .replace(/^\[.*?context.*?\][\s\S]*?\n\n/im, '')
    .trim()
}

/**
 * Compact a raw JSONL session file into a structured, LLM-ready form.
 * Returns `null` if the file does not exist.
 */
export function compactSessionJsonl(jsonlPath: string): CompactedSession | null {
  if (!existsSync(jsonlPath)) return null

  const rawBytes = statSync(jsonlPath).size
  const content = readFileSync(jsonlPath, 'utf-8')
  return compactJsonlContent(content, rawBytes)
}

/**
 * Compact an in-memory JSONL string (e.g. a byte-offset slice of a session file).
 * Exposed for incremental callers that already hold a delta slice.
 */
export function compactJsonlContent(content: string, rawBytes: number): CompactedSession {
  const lines = content.split('\n')

  const turns: CompactTurn[] = []
  // Map of tool_use_id → index into turn.tools so we can attach tool_results
  // that arrive either inside the next user message or as top-level entries.
  const pendingTools = new Map<string, { turn: CompactTurn; toolIdx: number }>()

  let toolCalls = 0
  let hasMutating = false
  let hasLongUserMessage = false

  for (const line of lines) {
    if (!line.trim()) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }

    if (!entry?.type) continue
    if (entry.type === 'file-history-snapshot') continue
    if (entry.type === 'custom-title') continue
    if (entry.type === 'queue-operation') continue
    if (entry.type === 'last-prompt') continue
    if (entry.type === 'system') continue

    // --- User message ---
    if (entry.type === 'user' && entry.message?.content) {
      const contentArr = Array.isArray(entry.message.content)
        ? entry.message.content
        : [{ type: 'text', text: String(entry.message.content) }]

      // First, route any tool_result blocks to their pending tool_use.
      for (const block of contentArr) {
        if (block?.type === 'tool_result') {
          const id = block.tool_use_id
          const pending = id ? pendingTools.get(id) : undefined
          if (pending) {
            const isError = block.is_error === true
            pending.turn.tools![pending.toolIdx].ok = !isError
            const summary = summarizeToolResult(block.content, isError)
            if (summary) pending.turn.tools![pending.toolIdx].result = summary
            pendingTools.delete(id)
          }
        }
      }

      const rawText = extractTextBlock(contentArr)
      if (!rawText) continue
      const text = stripInjectedContext(rawText)
      if (!text) continue

      if (text.length > USER_TEXT_TRIVIAL_THRESHOLD) hasLongUserMessage = true
      turns.push({ role: 'user', text })
      continue
    }

    // --- Assistant message ---
    if (entry.type === 'assistant' && entry.message?.content) {
      const contentArr = Array.isArray(entry.message.content)
        ? entry.message.content
        : [{ type: 'text', text: String(entry.message.content) }]

      const turn: CompactTurn = { role: 'assistant' }
      const textParts: string[] = []
      const thinkingParts: string[] = []
      const tools: CompactTool[] = []

      for (const block of contentArr) {
        if (!block?.type) continue
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          textParts.push(block.text.trim())
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          thinkingParts.push(block.thinking.trim())
        } else if (block.type === 'tool_use') {
          const name = block.name || 'unknown'
          const input = summarizeToolInput(name, block.input)
          const tool: CompactTool = { name, input }
          tools.push(tool)
          toolCalls++
          if (MUTATING_TOOLS.has(name)) hasMutating = true
          else if (name === 'Bash' && typeof input === 'string' && isMutatingBash(input)) hasMutating = true
          if (block.id) pendingTools.set(block.id, { turn, toolIdx: tools.length - 1 })
        } else if (block.type === 'tool_result') {
          // Rare: tool_result nested inside assistant content.
          const id = block.tool_use_id
          const pending = id ? pendingTools.get(id) : undefined
          if (pending) {
            const isError = block.is_error === true
            pending.turn.tools![pending.toolIdx].ok = !isError
            const summary = summarizeToolResult(block.content, isError)
            if (summary) pending.turn.tools![pending.toolIdx].result = summary
            pendingTools.delete(id)
          }
        }
      }

      if (textParts.length > 0) turn.text = textParts.join('\n\n')
      if (thinkingParts.length > 0) turn.thinking = truncate(thinkingParts.join(' / '), THINKING_MAX)
      if (tools.length > 0) turn.tools = tools

      if (turn.text || turn.thinking || turn.tools) turns.push(turn)
      continue
    }

    // --- Top-level tool_result (outside a message wrapper) ---
    if (entry.type === 'tool_result') {
      const id = entry.tool_use_id
      const pending = id ? pendingTools.get(id) : undefined
      if (pending) {
        const isError = entry.is_error === true
        pending.turn.tools![pending.toolIdx].ok = !isError
        const summary = summarizeToolResult(entry.content, isError)
        if (summary) pending.turn.tools![pending.toolIdx].result = summary
        pendingTools.delete(id)
      }
    }
  }

  const compactedJson = JSON.stringify(turns)
  const compactedBytes = Buffer.byteLength(compactedJson, 'utf-8')

  const trivial = !hasMutating && !hasLongUserMessage

  return {
    turns,
    stats: {
      totalTurns: turns.length,
      toolCalls,
      rawBytes,
      compactedBytes,
      trivial,
    },
  }
}
