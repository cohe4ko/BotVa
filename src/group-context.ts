/**
 * Group context injection: during active debates, human messages are stored
 * as context (not debate turns) and injected into both bots' next messages.
 *
 * Storage: store/group-context/<chatId>.txt (one line per entry, shared between bot processes)
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

const CONTEXT_DIR = resolve(PROJECT_ROOT, 'store', 'group-context')

function ensureDir(): void {
  if (!existsSync(CONTEXT_DIR)) {
    mkdirSync(CONTEXT_DIR, { recursive: true })
  }
}

function filePath(chatId: string): string {
  return resolve(CONTEXT_DIR, `${chatId}.txt`)
}

/** Append a context line from the user */
export function appendGroupContext(chatId: string, text: string): void {
  ensureDir()
  const clean = text.replace(/\n/g, ' ').trim()
  if (!clean) return
  appendFileSync(filePath(chatId), clean + '\n', 'utf-8')
  logger.debug({ chatId, chars: clean.length }, 'Group context appended')
}

/** Read all injected context lines. Returns null if no context. */
export function readGroupContext(chatId: string): string | null {
  const fp = filePath(chatId)
  if (!existsSync(fp)) return null
  const content = readFileSync(fp, 'utf-8').trim()
  if (!content) return null
  const lines = content.split('\n').filter(Boolean)
  return lines.map(l => `- ${l}`).join('\n')
}

/** Clear injected context (on /stop, debate end) */
export function clearGroupContext(chatId: string): void {
  const fp = filePath(chatId)
  try {
    if (existsSync(fp)) unlinkSync(fp)
  } catch {
    // ignore
  }
}
