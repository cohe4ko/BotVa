/**
 * Telegram Observer — client side of the MCP socket.
 *
 * A bot process must never open its own MTProto connection: two clients on one
 * session is how an account gets its session revoked. Every live action goes
 * through the observer daemon, which owns the single connection and applies the
 * throttle and the send budget.
 *
 * This is the same newline-delimited JSON-RPC the stdio shim pipes, spoken
 * directly so scheduled code can call a tool without an agent in the loop.
 */

import { connect, type Socket } from 'net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { TG_SOCK_PATH } from './paths.js'

const CONNECT_TIMEOUT_MS = 5000

class ClientSocketTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private buffer = ''

  constructor(private socket: Socket) {}

  async start(): Promise<void> {
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8')
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (!line) continue
        try {
          this.onmessage?.(JSON.parse(line) as JSONRPCMessage)
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })
    this.socket.on('close', () => this.onclose?.())
    this.socket.on('error', err => this.onerror?.(err))
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.socket.destroyed) return
    this.socket.write(JSON.stringify(message) + '\n')
  }

  async close(): Promise<void> {
    this.socket.end()
  }
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Observer socket did not answer within ${CONNECT_TIMEOUT_MS}ms`))
    }, CONNECT_TIMEOUT_MS)

    socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', err => { clearTimeout(timer); reject(err) })
  })
}

export interface ObserverSession {
  call(tool: string, args: Record<string, unknown>): Promise<string>
  close(): Promise<void>
}

/**
 * Open a short-lived session to the observer.
 *
 * Deliberately not pooled: the daemon builds one MCP server per connection, and
 * a scheduled pass makes a handful of calls a minute at most. Holding a socket
 * open across a daemon restart would be a silent dead channel.
 */
export async function openObserver(sockPath = TG_SOCK_PATH): Promise<ObserverSession> {
  const socket = await openSocket(sockPath)
  const client = new Client({ name: 'botva-bot', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new ClientSocketTransport(socket))

  return {
    async call(tool, args) {
      const res = await client.callTool({ name: tool, arguments: args }) as {
        content?: { type: string; text?: string }[]
        isError?: boolean
      }
      const text = (res.content ?? [])
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .join('\n')
      if (res.isError) throw new Error(text || `Інструмент ${tool} повернув помилку`)
      return text
    },
    async close() {
      await client.close().catch(() => undefined)
      socket.destroy()
    },
  }
}

/** True when the observer daemon is up and answering. */
export async function observerAvailable(sockPath = TG_SOCK_PATH): Promise<boolean> {
  try {
    const s = await openObserver(sockPath)
    await s.close()
    return true
  } catch {
    return false
  }
}
