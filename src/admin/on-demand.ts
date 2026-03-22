import { serve } from '@hono/node-server'
import { createAdminApp } from './server.js'
import { setSessionToken, setCookiePort } from './auth.js'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { resolve } from 'path'
import crypto from 'crypto'
import os from 'os'
import { logger } from '../logger.js'
import { attachTerminalWS, cleanupAllTerminals } from './terminal-ws.js'

const LOCK_FILE = resolve(process.cwd(), 'workspace', 'admin.lock')

function getLocalIP(): string {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return '127.0.0.1'
}

/** Build admin base URL. ADMIN_HOST can be full URL (https://admin.example.com) or hostname/IP */
function buildBaseUrl(port: number): string {
  const host = process.env.ADMIN_HOST
  if (host) {
    // Full URL — use as-is (port already handled by reverse proxy)
    if (host.startsWith('http://') || host.startsWith('https://')) return host
    // Just hostname — add http + port
    return `http://${host}:${port}`
  }
  return `http://${getLocalIP()}:${port}`
}
const INACTIVITY_MS = 20 * 60 * 1000 // 20 minutes

interface LockData {
  pid: number
  port: number
  token: string
  startedBy: string
  startedAt: number
  baseUrl?: string
}

interface AdminState {
  server: ReturnType<typeof serve> | null
  token: string | null
  timer: ReturnType<typeof setTimeout> | null
  onShutdown: (() => void) | null
}

const state: AdminState = {
  server: null,
  token: null,
  timer: null,
  onShutdown: null,
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readLock(): LockData | null {
  if (!existsSync(LOCK_FILE)) return null
  try {
    return JSON.parse(readFileSync(LOCK_FILE, 'utf-8'))
  } catch { return null }
}

function writeLock(data: LockData): void {
  writeFileSync(LOCK_FILE, JSON.stringify(data))
}

function removeLock(): void {
  try { unlinkSync(LOCK_FILE) } catch {}
}

function resetTimer(): void {
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    logger.info('Admin panel: 20 хв неактивності, зупиняю...')
    stopAdmin()
  }, INACTIVITY_MS)
}

export function isAdminRunning(): { running: boolean; url?: string; token?: string; port?: number } {
  // Check if we started it ourselves
  if (state.server && state.token) {
    const lock = readLock()
    return { running: true, url: buildBaseUrl(lock?.port ?? parseInt(process.env.ADMIN_PORT || '3000', 10)), token: state.token, port: lock?.port }
  }

  // Check lock file (another bot may have started it)
  const lock = readLock()
  if (lock && isProcessAlive(lock.pid)) {
    const url = lock.baseUrl || buildBaseUrl(lock.port)
    return { running: true, url, token: lock.token, port: lock.port }
  }

  // Stale lock
  if (lock) removeLock()
  return { running: false }
}

export function startAdmin(port: number, botName: string, onShutdown: () => void): { url: string; token: string } {
  // Already running?
  const existing = isAdminRunning()
  if (existing.running) {
    return { url: `${existing.url}/?token=${existing.token}`, token: existing.token! }
  }

  // Kill whatever occupies the port (e.g. standalone admin via deploy.sh)
  killPortOccupant(port)

  // Generate token
  const token = crypto.randomBytes(16).toString('hex')
  setCookiePort(port)
  setSessionToken(token)
  state.token = token
  state.onShutdown = onShutdown

  // Create Hono app
  const app = createAdminApp()

  // Wrap app.fetch with inactivity timer reset
  const originalFetch = app.fetch.bind(app)
  const wrappedFetch = (req: Request, ...args: any[]) => {
    resetTimer()
    return originalFetch(req, ...args)
  }

  // Add /api/shutdown endpoint
  app.post('/api/shutdown', async (c) => {
    const q = c.req.query('token')
    if (q !== token) return c.text('Unauthorized', 401)
    setTimeout(() => stopAdmin(), 100)
    return c.json({ ok: true })
  })

  // Start HTTP server
  state.server = serve({ fetch: wrappedFetch as any, port, hostname: '0.0.0.0' })

  // Attach WebSocket for terminal
  attachTerminalWS(state.server)

  // Handle server errors (e.g. port conflict race condition)
  state.server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error({ port }, `Port ${port} already in use — admin panel not started`)
      state.server = null
      setSessionToken(null)
      state.token = null
      removeLock()
    }
  })

  // Write lock
  const baseUrl = buildBaseUrl(port)
  writeLock({ pid: process.pid, port, token, startedBy: botName, startedAt: Date.now(), baseUrl })

  // Start inactivity timer
  resetTimer()

  const url = `${buildBaseUrl(port)}/?token=${token}`
  logger.info({ port, botName }, `Admin panel запущено: ${url}`)
  return { url, token }
}

function killPortOccupant(port: number): void {
  let pids: string
  try {
    pids = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: 'utf-8', timeout: 2000 }).trim()
  } catch {
    return // port is free
  }
  if (!pids) return
  for (const pid of pids.split('\n')) {
    const n = parseInt(pid, 10)
    if (n && n !== process.pid) {
      logger.info({ port, pid: n }, 'Killing process occupying admin port')
      try { process.kill(n, 'SIGKILL') } catch {}
    }
  }
}

export function stopAdmin(manual = false): void {
  if (state.timer) { clearTimeout(state.timer); state.timer = null }
  cleanupAllTerminals()
  if (state.server) {
    state.server.close()
    state.server = null
  }

  // Only kill port occupant if we started the server ourselves (on-demand mode)
  // Don't kill standalone admin started via deploy.sh
  if (state.token) {
    const lock = readLock()
    const port = lock?.port ?? parseInt(process.env.ADMIN_PORT || '3000', 10)
    killPortOccupant(port)
  }

  setSessionToken(null)
  state.token = null
  removeLock()
  logger.info('Admin panel зупинено')
  if (!manual && state.onShutdown) { state.onShutdown(); state.onShutdown = null }
  if (manual) state.onShutdown = null
}
