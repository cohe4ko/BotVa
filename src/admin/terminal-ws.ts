import { WebSocketServer, WebSocket } from 'ws'
import * as pty from 'node-pty'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import crypto from 'crypto'
import { chmodSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { validateAuthFromCookieHeader } from './auth.js'
import { logger } from '../logger.js'

const MAX_TERMINALS = 5
const SCROLLBACK_LIMIT = 100_000
const SESSIONS_DIR = join(process.cwd(), 'workspace', 'terminal-sessions')
const SAVE_INTERVAL_MS = 10_000

// --- Types ---

interface SessionMeta { id: string; createdAt: number }

interface TermSession {
  id: string
  pty: pty.IPty | null
  ws: WebSocket | null
  scrollback: string
  createdAt: number
  alive: boolean
  dirty: boolean
}

const sessions = new Map<string, TermSession>()
let saveTimer: ReturnType<typeof setInterval> | null = null

// --- Persistence ---

function ensureDir(): void { mkdirSync(SESSIONS_DIR, { recursive: true }) }

function saveMeta(session: TermSession): void {
  try {
    ensureDir()
    writeFileSync(join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify({ id: session.id, createdAt: session.createdAt }))
  } catch (err) { logger.error({ err }, '[terminal] saveMeta') }
}

function saveScrollback(session: TermSession): void {
  if (!session.dirty) return
  try {
    ensureDir()
    writeFileSync(join(SESSIONS_DIR, `${session.id}.log`), session.scrollback)
    session.dirty = false
  } catch (err) { logger.error({ err }, '[terminal] saveScrollback') }
}

function deletePersisted(id: string): void {
  try { unlinkSync(join(SESSIONS_DIR, `${id}.json`)) } catch {}
  try { unlinkSync(join(SESSIONS_DIR, `${id}.log`)) } catch {}
}

function loadPersistedSessions(): void {
  ensureDir()
  try {
    for (const file of readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const meta: SessionMeta = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'))
        if (sessions.has(meta.id)) continue
        const logPath = join(SESSIONS_DIR, `${meta.id}.log`)
        const scrollback = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : ''
        sessions.set(meta.id, { id: meta.id, pty: null, ws: null, scrollback, createdAt: meta.createdAt, alive: false, dirty: false })
      } catch {}
    }
  } catch {}
}

function startSaveTimer(): void {
  if (saveTimer) return
  saveTimer = setInterval(() => {
    for (const s of sessions.values()) if (s.dirty) saveScrollback(s)
  }, SAVE_INTERVAL_MS)
}

// --- Helpers ---

function fixSpawnHelper(): void {
  try {
    chmodSync(join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), 0o755)
  } catch {}
}

function getUserShell(): string { return process.env.SHELL || '/bin/zsh' }

/** Merge user-bin paths into PATH so `claude` (installed in ~/.local/bin, ~/.bun/bin, /opt/homebrew/bin)
 *  resolves even when bot was launched by launchd with a stripped PATH. zsh -lc cannot fix this on its
 *  own because the user has no .zprofile/.zlogin and .zshrc is interactive-only. */
function getEnhancedPath(): string {
  const home = process.env.HOME || ''
  const extras = [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.opencode', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  const current = (process.env.PATH || '').split(':').filter(Boolean)
  const seen = new Set(current)
  const prepended = extras.filter(p => !seen.has(p))
  return [...prepended, ...current].join(':')
}

function getPtyEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TERM: 'xterm-256color', PATH: getEnhancedPath() }
}

/** Strip terminal query responses (DA, focus) that leak through PTY */
const TERM_NOISE_RE = /\x1b\[\??[\d;]*[cI]/g
function cleanPtyOutput(data: string): string { return data.replace(TERM_NOISE_RE, '') }

/** Send control message (NUL-prefixed to distinguish from PTY data) */
function sendCtrl(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send('\0' + JSON.stringify(msg))
}

function appendScrollback(session: TermSession, data: string): void {
  session.scrollback += data
  session.dirty = true
  if (session.scrollback.length > SCROLLBACK_LIMIT * 1.5) {
    session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT)
  }
}

// --- Public API ---

export function getActiveSessions(): { id: string; createdAt: number; connected: boolean; alive: boolean }[] {
  return Array.from(sessions.values()).map(s => ({
    id: s.id, createdAt: s.createdAt, connected: s.ws !== null, alive: s.alive,
  }))
}

export function deleteSession(id: string): boolean {
  const session = sessions.get(id)
  if (!session) return false
  if (session.alive && session.pty) try { session.pty.kill() } catch {}
  try { session.ws?.close() } catch {}
  sessions.delete(id)
  deletePersisted(id)
  return true
}

// --- PTY spawn ---

function spawnClaude(session: TermSession, userShell: string, cmd: string): void {
  const shell = pty.spawn(userShell, ['-lc', cmd], {
    name: 'xterm-256color', cols: 80, rows: 24,
    cwd: process.cwd(),
    env: getPtyEnv(),
  })
  session.pty = shell
  session.alive = true
  session.scrollback = ''
  session.dirty = true
  if (session.ws?.readyState === WebSocket.OPEN) {
    sendCtrl(session.ws, { type: 'alive' })
  }

  shell.onData((raw: string) => {
    const data = cleanPtyOutput(raw)
    if (!data) return
    appendScrollback(session, data)
    if (session.ws?.readyState === WebSocket.OPEN) session.ws.send(data)
  })

  shell.onExit(({ exitCode }) => {
    session.alive = false
    session.pty = null
    saveScrollback(session)
    // If --resume failed, fallback to fresh claude
    if (exitCode === 1 && cmd.includes('--resume')) {
      if (session.ws?.readyState === WebSocket.OPEN) {
        session.ws.send('\r\n[Resume failed, starting new session...]\r\n')
      }
      spawnClaude(session, userShell, 'claude')
      return
    }
    if (session.ws?.readyState === WebSocket.OPEN) {
      sendCtrl(session.ws, { type: 'exit', code: exitCode })
    }
  })
}

function reviveSession(session: TermSession, userShell: string): void {
  spawnClaude(session, userShell, `claude --resume ${session.id}`)
}

// --- WebSocket ---

export function attachTerminalWS(server: { on: Function }): void {
  const wss = new WebSocketServer({ noServer: true })
  fixSpawnHelper()
  loadPersistedSessions()
  startSaveTimer()
  const userShell = getUserShell()

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    if (url.pathname !== '/terminal/ws') return
    if (!validateAuthFromCookieHeader(req.headers.cookie)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    const requestedSession = url.searchParams.get('session')

    // Reconnect to existing session
    if (requestedSession && sessions.has(requestedSession)) {
      const session = sessions.get(requestedSession)!
      if (session.ws?.readyState === WebSocket.OPEN) session.ws.close()
      session.ws = ws
      sendCtrl(ws, { type: 'session', id: session.id })

      if (session.alive && session.scrollback) {
        ws.send(cleanPtyOutput(session.scrollback))
      } else if (!session.alive) {
        if (session.scrollback) ws.send(cleanPtyOutput(session.scrollback))
        sendCtrl(ws, { type: 'dead' })
      }

      wireWsToSession(ws, session, userShell)
      return
    }

    // New session — count alive for limit
    let aliveCount = 0
    for (const s of sessions.values()) if (s.alive) aliveCount++
    if (aliveCount >= MAX_TERMINALS) {
      sendCtrl(ws, { type: 'error', message: 'Max terminals reached' })
      ws.close()
      return
    }

    const id = crypto.randomUUID()
    let shell: pty.IPty
    try {
      shell = pty.spawn(userShell, ['-lc', `claude --session-id ${id}`], {
        name: 'xterm-256color', cols: 80, rows: 24,
        cwd: process.cwd(),
        env: getPtyEnv(),
      })
    } catch (err) {
      ws.send(`\r\nFailed to start claude: ${err}\r\n`)
      ws.close()
      return
    }

    const session: TermSession = { id, pty: shell, ws, scrollback: '', createdAt: Date.now(), alive: true, dirty: false }
    sessions.set(id, session)
    ensureDir()
    saveMeta(session)
    sendCtrl(ws, { type: 'session', id })

    shell.onData((raw: string) => {
      const data = cleanPtyOutput(raw)
      if (!data) return
      appendScrollback(session, data)
      if (session.ws?.readyState === WebSocket.OPEN) session.ws.send(data)
    })

    shell.onExit(({ exitCode }) => {
      session.alive = false
      session.pty = null
      saveScrollback(session)
      if (session.ws?.readyState === WebSocket.OPEN) {
        sendCtrl(session.ws, { type: 'exit', code: exitCode })
      }
    })

    wireWsToSession(ws, session, userShell)
  })
}

function wireWsToSession(ws: WebSocket, session: TermSession, userShell: string): void {
  ws.on('message', (raw: Buffer) => {
    const msg = raw.toString()
    try {
      const parsed = JSON.parse(msg)
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        if (session.alive && session.pty) session.pty.resize(parsed.cols, parsed.rows)
        return
      }
      if (parsed.type === 'revive' && !session.alive) {
        reviveSession(session, userShell)
        return
      }
    } catch {}
    if (session.alive && session.pty) session.pty.write(msg)
  })

  ws.on('close', () => {
    if (session.ws === ws) session.ws = null
  })
}

export function cleanupAllTerminals(): void {
  for (const session of sessions.values()) {
    saveScrollback(session)
    if (session.alive && session.pty) try { session.pty.kill() } catch {}
    try { session.ws?.close() } catch {}
  }
  sessions.clear()
  if (saveTimer) { clearInterval(saveTimer); saveTimer = null }
}
