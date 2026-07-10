import { readdirSync, statSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

export interface DiskSession {
  sessionId: string
  preview: string
  slug: string
  title: string
  updatedAt: number // unix seconds
  fileSize: number  // bytes
}

export interface ClaudeProject {
  key: string        // raw dir name: -Users-ivan-BotVa-bots-cap
  label: string      // friendly: BotVa/cap
  sessionCount: number
  lastUpdated: number // unix seconds
}

/** Extract readable text from message content (handles string and array-of-blocks formats) */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text
    }
  }
  return ''
}

/** Filter out service/internal sessions (consolidation, diagnostics, warmup, fact extraction) */
const SERVICE_SESSION_PATTERNS = [
  /^Extract ALL important facts/i,
  /^You are running in diagnostic mode/i,
  /^Прочитай цей файл і збережи/,
  /^Ти — система консолідації/,
  /^Warmup$/i,
  /^Out$/i,
]

function isServiceSession(preview: string): boolean {
  return SERVICE_SESSION_PATTERNS.some(re => re.test(preview))
}

export interface SessionDetail {
  firstMessage: string
  lastUserMessage: string
  updatedAt: number
}

export interface ContentBlock {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text?: string
  toolName?: string
  toolInput?: string
  toolUseId?: string
}

export interface SessionMessage {
  type: 'user' | 'assistant'
  blocks: ContentBlock[]
  timestamp?: string
}

export interface FullSession {
  sessionId: string
  title: string
  messages: SessionMessage[]
  updatedAt: number
}

/** Read session detail — first user message + last user message */
export function getSessionDetail(sessionId: string): SessionDetail | null {
  const root = getClaudeProjectsRoot()
  // Search across all projects for this session
  try {
    const dirs = readdirSync(root)
    for (const dir of dirs) {
      const filePath = join(root, dir, `${sessionId}.jsonl`)
      try {
        const stat = statSync(filePath)
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')
        let firstMessage = ''
        let lastUserMessage = ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry.type === 'user' && entry.message?.content) {
              const text = extractMessageText(entry.message.content)
              if (!text) continue
              const cleaned = text
                .replace(/^\[Щоденник.*?\n[\s\S]*?\n\n/m, '')
                .replace(/^\[Memory context\][\s\S]*?\n\n/m, '')
                .trim()
              if (!cleaned) continue
              if (!firstMessage) firstMessage = cleaned
              lastUserMessage = cleaned
            }
          } catch { /* skip */ }
        }
        const trimTo = (s: string, n: number) => {
          const oneLine = s.split('\n').slice(0, 3).join('\n')
          return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine
        }
        return {
          firstMessage: trimTo(firstMessage, 200),
          lastUserMessage: firstMessage === lastUserMessage ? '' : trimTo(lastUserMessage, 200),
          updatedAt: Math.floor(stat.mtimeMs / 1000),
        }
      } catch { /* file not in this dir */ }
    }
  } catch { /* root not accessible */ }
  return null
}

function getClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/** Result of computing an undo (rewind) anchor over a session JSONL. */
export type UndoAnchor =
  | { action: 'anchor'; anchorUuid: string; removedPreview: string }
  | { action: 'clear' }
  | { action: 'none' }

/**
 * Pure, testable core of /undo: given the raw JSONL of a Claude session,
 * decide where the NEXT turn should resume so the last user↔agent exchange
 * is dropped.
 *
 * Structure of a Claude session JSONL:
 * - real user prompts:  { type:'user', message.content = string | [{type:'text'},…], uuid, promptSource:'sdk'|'user' }
 * - tool results:       { type:'user', message.content = [{type:'tool_result'}] }  ← NOT a real user turn
 * - assistant messages: { type:'assistant', message.content=[…], uuid }
 * - meta/service lines:  queue-operation, attachment, ai-title, custom-title, file-history-snapshot, …
 *
 * We keep only real user turns (extractMessageText non-empty, not isMeta) and
 * assistant turns. To undo the last exchange we resume "up to and including"
 * (see SDK `resumeSessionAt`) the last assistant message that precedes the last
 * real user prompt — i.e. the answer that concluded the previous turn.
 *
 * - 0 real user turns  → 'none'  (nothing to undo)
 * - 1 real user turn   → 'clear' (undo would empty the session)
 * - ≥2 real user turns → 'anchor' at that preceding assistant uuid
 */
export function selectUndoAnchor(jsonl: string): UndoAnchor {
  interface RewindEntry { type: 'user' | 'assistant'; uuid?: string; isRealUser: boolean; text: string }
  const entries: RewindEntry[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue }
    if (e?.type === 'user' && e.message?.content) {
      const text = extractMessageText(e.message.content)
      entries.push({ type: 'user', uuid: e.uuid, isRealUser: !!text && !e.isMeta, text })
    } else if (e?.type === 'assistant' && e.uuid) {
      entries.push({ type: 'assistant', uuid: e.uuid, isRealUser: false, text: '' })
    }
  }

  const realUserIdx: number[] = []
  entries.forEach((en, i) => { if (en.isRealUser) realUserIdx.push(i) })

  if (realUserIdx.length === 0) return { action: 'none' }
  if (realUserIdx.length < 2) return { action: 'clear' }

  const lastUserIdx = realUserIdx[realUserIdx.length - 1]
  let anchorUuid: string | undefined
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    if (entries[i].type === 'assistant' && entries[i].uuid) { anchorUuid = entries[i].uuid; break }
  }
  if (!anchorUuid) return { action: 'clear' }

  return { action: 'anchor', anchorUuid, removedPreview: entries[lastUserIdx].text.slice(0, 80) }
}

/** Read a session's JSONL from disk and compute its undo anchor. */
export function computeUndoAnchor(botDir: string, sessionId: string): UndoAnchor {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) return { action: 'none' }
  const filePath = join(getClaudeProjectDir(botDir), `${sessionId}.jsonl`)
  try {
    return selectUndoAnchor(readFileSync(filePath, 'utf-8'))
  } catch {
    return { action: 'none' }
  }
}

/** Get Claude project dir for a given bot working directory */
export function getClaudeProjectDir(botDir: string): string {
  const projectKey = botDir.replace(/\//g, '-')
  return join(getClaudeProjectsRoot(), projectKey)
}

/** Make friendly label from project key: -Users-ivan-BotVa-bots-cap → BotVa/cap */
function projectLabel(key: string): string {
  // Remove leading dash, split by -Users-<user>-
  const parts = key.replace(/^-/, '').split('-')
  // Find the meaningful part — skip Users, username
  // Pattern: Users-<user>-<project>[-bots-<bot>][-subdir]
  const usersIdx = parts.indexOf('Users')
  if (usersIdx >= 0 && usersIdx + 2 < parts.length) {
    const meaningful = parts.slice(usersIdx + 2)
    // Collapse bots/<name> to project/name
    const botsIdx = meaningful.indexOf('bots')
    if (botsIdx >= 0 && botsIdx + 1 < meaningful.length) {
      const project = meaningful.slice(0, botsIdx).join('-')
      const bot = meaningful.slice(botsIdx + 1).join('-')
      return project ? `${project}/${bot}` : bot
    }
    return meaningful.join('-')
  }
  // Fallback: just use the key with leading dash removed
  return key.replace(/^-/, '')
}

/** List all Claude projects with session counts */
export function listClaudeProjects(): ClaudeProject[] {
  const root = getClaudeProjectsRoot()
  try {
    const dirs = readdirSync(root).filter(d => {
      try { return statSync(join(root, d)).isDirectory() } catch { return false }
    })
    const projects: ClaudeProject[] = []
    for (const dir of dirs) {
      const dirPath = join(root, dir)
      try {
        const jsonlFiles = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))
        if (jsonlFiles.length === 0) continue
        // Get last modified time from most recent file
        let lastUpdated = 0
        for (const f of jsonlFiles.slice(0, 5)) {
          try {
            const mt = Math.floor(statSync(join(dirPath, f)).mtimeMs / 1000)
            if (mt > lastUpdated) lastUpdated = mt
          } catch { /* skip */ }
        }
        projects.push({
          key: dir,
          label: projectLabel(dir),
          sessionCount: jsonlFiles.length,
          lastUpdated,
        })
      } catch { /* skip unreadable dirs */ }
    }
    projects.sort((a, b) => b.lastUpdated - a.lastUpdated)
    return projects
  } catch {
    return []
  }
}

/** List all user-facing sessions from a specific Claude project directory */
export function listDiskSessions(botDir: string): DiskSession[] {
  const projectDir = getClaudeProjectDir(botDir)
  return listDiskSessionsFromDir(projectDir)
}

/** List sessions from a project key (raw directory name) */
export function listDiskSessionsByKey(projectKey: string): DiskSession[] {
  const projectDir = join(getClaudeProjectsRoot(), projectKey)
  return listDiskSessionsFromDir(projectDir)
}

function listDiskSessionsFromDir(projectDir: string): DiskSession[] {
  try {
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.includes('/'))
    const sessions: DiskSession[] = []
    for (const file of files) {
      const sessionId = file.replace('.jsonl', '')
      const filePath = join(projectDir, file)
      try {
        const stat = statSync(filePath)
        let preview = ''
        let slug = ''
        const content = readFileSync(filePath, 'utf-8')
        const allLines = content.split('\n')
        for (const line of allLines.slice(0, 30)) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (!slug && entry.slug) slug = entry.slug
            if (!preview && entry.type === 'user' && entry.message?.content) {
              const text = extractMessageText(entry.message.content)
              if (text) {
                const cleaned = text
                  .replace(/^\[Щоденник.*?\n/s, '')
                  .replace(/^\[Memory context\].*?\n/s, '')
                  .trim()
                const firstLine = cleaned.split('\n').find(l => l.trim().length > 5) ?? cleaned.split('\n')[0] ?? ''
                preview = firstLine.trim().slice(0, 80)
                if (firstLine.length > 80) preview += '…'
              }
            }
            if (preview && slug) break
          } catch { /* skip malformed lines */ }
        }
        // Read custom-title from last lines (Claude Code /rename format)
        let title = ''
        for (const line of allLines.slice(-15)) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle
          } catch { /* skip */ }
        }
        sessions.push({
          sessionId,
          preview: preview || '(empty)',
          slug: slug || '',
          title,
          updatedAt: Math.floor(stat.mtimeMs / 1000),
          fileSize: stat.size,
        })
      } catch { /* skip unreadable files */ }
    }
    const userSessions = sessions.filter(s => s.preview !== '(empty)' && !isServiceSession(s.preview))
    userSessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return userSessions
  } catch {
    return []
  }
}

export interface SessionStats {
  messages: number
  inputTokens: number
  outputTokens: number
}

/** Cache for session stats: sessionId -> { stats, mtime } */
const sessionStatsCache = new Map<string, { stats: SessionStats; mtime: number }>()

/** Count messages and tokens in a session (cached by mtime) */
export function getSessionStats(botDir: string, sessionId: string): SessionStats | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) return null
  const projectDir = getClaudeProjectDir(botDir)
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  try {
    const stat = statSync(filePath)
    const mtime = Math.floor(stat.mtimeMs)
    const cached = sessionStatsCache.get(sessionId)
    if (cached && cached.mtime === mtime) return cached.stats

    const content = readFileSync(filePath, 'utf-8')
    let messages = 0
    let inputTokens = 0
    let outputTokens = 0
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'user' || entry.type === 'assistant') messages++
        if (entry.type === 'assistant' && entry.message?.usage) {
          inputTokens += entry.message.usage.input_tokens || 0
          outputTokens += entry.message.usage.output_tokens || 0
        }
      } catch { /* skip */ }
    }
    const stats = { messages, inputTokens, outputTokens }
    sessionStatsCache.set(sessionId, { stats, mtime })
    return stats
  } catch {
    return null
  }
}

/** Read full session for viewing — all messages with content blocks */
export function readFullSession(botDir: string, sessionId: string): FullSession | null {
  // Validate sessionId format (UUID)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) return null

  const projectDir = getClaudeProjectDir(botDir)
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  try {
    const stat = statSync(filePath)
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    const messages: SessionMessage[] = []
    let title = ''

    for (const line of lines) {
      if (!line.trim()) continue
      let entry: any
      try { entry = JSON.parse(line) } catch { continue }

      if (entry.type === 'custom-title' && entry.customTitle) {
        title = entry.customTitle
        continue
      }

      if (entry.type === 'file-history-snapshot') continue

      if (entry.type === 'user' && entry.message?.content) {
        const text = extractMessageText(entry.message.content)
        if (!text) continue
        const cleaned = text
          .replace(/^\[Щоденник.*?\n[\s\S]*?\n\n/m, '')
          .replace(/^\[Memory context\][\s\S]*?\n\n/m, '')
          .trim()
        if (!cleaned) continue
        messages.push({
          type: 'user',
          blocks: [{ kind: 'text', text: cleaned }],
          timestamp: entry.timestamp,
        })
      }

      if (entry.type === 'assistant' && entry.message?.content) {
        const blocks: ContentBlock[] = []
        const contentArr = Array.isArray(entry.message.content) ? entry.message.content : [{ type: 'text', text: String(entry.message.content) }]
        for (const block of contentArr) {
          if (!block || !block.type) continue
          if (block.type === 'text' && block.text) {
            blocks.push({ kind: 'text', text: block.text })
          } else if (block.type === 'thinking' && block.thinking) {
            blocks.push({ kind: 'thinking', text: block.thinking })
          } else if (block.type === 'tool_use') {
            blocks.push({
              kind: 'tool_use',
              toolName: block.name || 'unknown',
              toolInput: typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2),
              toolUseId: block.id,
            })
          } else if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
                : JSON.stringify(block.content)
            blocks.push({
              kind: 'tool_result',
              text: resultText,
              toolUseId: block.tool_use_id,
            })
          }
        }
        if (blocks.length > 0) {
          messages.push({
            type: 'assistant',
            blocks,
            timestamp: entry.timestamp,
          })
        }
      }

      // Top-level tool_result entries (outside assistant message)
      if (entry.type === 'tool_result' && entry.content) {
        const resultText = typeof entry.content === 'string'
          ? entry.content
          : Array.isArray(entry.content)
            ? entry.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
            : JSON.stringify(entry.content)
        // Attach to last assistant message if possible
        if (messages.length > 0 && messages[messages.length - 1].type === 'assistant') {
          messages[messages.length - 1].blocks.push({
            kind: 'tool_result',
            text: resultText,
            toolUseId: entry.tool_use_id,
          })
        }
      }
    }

    return {
      sessionId,
      title,
      messages,
      updatedAt: Math.floor(stat.mtimeMs / 1000),
    }
  } catch {
    return null
  }
}
