/**
 * Telegram Observer — status probe shared by the admin UI and CLI tooling.
 *
 * Reads only files and the database; never talks to the daemon, so it works
 * whether or not the daemon is up.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { TG_PID_PATH, TG_SOCK_PATH, TG_SESSION_PATH, TG_LOG_PATH } from './paths.js'
import { countMessages } from './db.js'
import { readCredentials } from './client.js'

export interface ObserverStatus {
  running: boolean
  pid: number | null
  socket: boolean
  session: boolean
  credentials: boolean
  messages: { total: number; incoming: number; outgoing: number; chats: number }
  logTail: string[]
}

function readPid(): number | null {
  if (!existsSync(TG_PID_PATH)) return null
  try {
    const pid = Number(readFileSync(TG_PID_PATH, 'utf-8').trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Last N lines of the daemon log, newest last. */
export function readLogTail(lines = 40): string[] {
  if (!existsSync(TG_LOG_PATH)) return []
  try {
    // Read at most the trailing 64 KB — the log grows unbounded between rotations.
    const size = statSync(TG_LOG_PATH).size
    const content = readFileSync(TG_LOG_PATH, 'utf-8')
    const text = size > 65536 ? content.slice(-65536) : content
    return text.split('\n').filter(l => l.trim()).slice(-lines)
  } catch {
    return []
  }
}

export function getObserverStatus(): ObserverStatus {
  const pid = readPid()
  const running = pid !== null && isAlive(pid)

  let messages = { total: 0, incoming: 0, outgoing: 0, chats: 0 }
  try {
    messages = countMessages()
  } catch { /* database not created yet */ }

  return {
    running,
    pid: running ? pid : null,
    socket: existsSync(TG_SOCK_PATH),
    session: existsSync(TG_SESSION_PATH),
    credentials: readCredentials() !== null,
    messages,
    logTail: readLogTail(),
  }
}
