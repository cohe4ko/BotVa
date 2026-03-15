import { WebSocketServer, WebSocket } from 'ws'
import * as pty from 'node-pty'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import crypto from 'crypto'
import { validateAuthFromCookieHeader } from './auth.js'

const MAX_TERMINALS = 3
const sessions = new Map<string, { pty: pty.IPty; ws: WebSocket }>()

export function attachTerminalWS(server: { on: Function }): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    if (url.pathname !== '/terminal/ws') return

    if (!validateAuthFromCookieHeader(req.headers.cookie)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    if (sessions.size >= MAX_TERMINALS) {
      ws.send(JSON.stringify({ type: 'error', message: 'Max terminals reached' }))
      ws.close()
      return
    }

    const id = crypto.randomUUID()
    const shell = pty.spawn('claude', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    })

    sessions.set(id, { pty: shell, ws })

    shell.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })

    shell.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }))
        ws.close()
      }
      sessions.delete(id)
    })

    ws.on('message', (raw: Buffer) => {
      const msg = raw.toString()
      try {
        const parsed = JSON.parse(msg)
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          shell.resize(parsed.cols, parsed.rows)
          return
        }
      } catch {}
      shell.write(msg)
    })

    ws.on('close', () => {
      sessions.delete(id)
      try { shell.kill() } catch {}
    })
  })
}

export function cleanupAllTerminals(): void {
  for (const [id, session] of sessions) {
    try { session.pty.kill() } catch {}
    try { session.ws.close() } catch {}
    sessions.delete(id)
  }
}
