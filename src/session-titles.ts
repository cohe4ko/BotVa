import { appendFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { getClaudeProjectDir } from './disk-sessions.js'
import { BOT_DIR } from './config.js'

/** Append a custom-title entry to the session JSONL file (Claude Code /rename format) */
export function writeSessionTitle(sessionId: string, title: string): void {
  const projectDir = getClaudeProjectDir(BOT_DIR)
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`)
  const entry = JSON.stringify({ type: 'custom-title', customTitle: title })
  appendFileSync(jsonlPath, entry + '\n')
}

/** Check if a session already has a custom title */
export function hasSessionTitle(sessionId: string): boolean {
  try {
    const projectDir = getClaudeProjectDir(BOT_DIR)
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`)
    const content = readFileSync(jsonlPath, 'utf-8')
    const lines = content.split('\n').slice(-20)
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'custom-title' && entry.customTitle) return true
      } catch { /* skip */ }
    }
    return false
  } catch {
    return false
  }
}
