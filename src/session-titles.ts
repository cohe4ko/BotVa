import { appendFileSync } from 'fs'
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
