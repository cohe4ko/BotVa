import { readdirSync, statSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

export interface DiskSession {
  sessionId: string
  preview: string
  slug: string
  title: string
  updatedAt: number // unix seconds
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
