import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { connect, type Socket } from 'net'

const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-tg-mcp-'))
})

vi.mock('./paths.js', () => ({
  PROJECT_ROOT: testDir,
  TG_STORE_DIR: testDir,
  TG_DB_PATH: join(testDir, 'telegram.db'),
  TG_SESSION_PATH: join(testDir, 'telegram.session'),
  TG_SOCK_PATH: join(testDir, 'telegram.sock'),
  TG_PID_PATH: join(testDir, 'telegram.pid'),
  TG_LOG_PATH: join(testDir, 'telegram-observer.log'),
  TG_MEDIA_DIR: join(testDir, 'media'),
}))

vi.mock('telegram/Utils.js', () => ({
  getPeerId: (e: { id?: unknown }) => String(e.id ?? '0'),
  getDisplayName: () => 'Тест',
}))

import { startMcpSocket, type McpSocketHandle } from './mcp.js'
import {
  getTgDb, closeTgDb, upsertChat, insertMessage, setChatCanSend, setChatUnread,
  recordOutbox, listOutbox,
} from './db.js'

const SOCK = join(testDir, 'telegram.sock')

/** Minimal newline-delimited JSON-RPC client — the same framing the shim pipes. */
class RpcClient {
  private socket: Socket
  private buffer = ''
  private pending = new Map<number, (msg: Record<string, unknown>) => void>()
  private nextId = 1

  constructor(socket: Socket) {
    this.socket = socket
    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf-8')
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line) as { id?: number }
        if (typeof msg.id === 'number') {
          this.pending.get(msg.id)?.(msg as Record<string, unknown>)
          this.pending.delete(msg.id)
        }
      }
    })
  }

  static async open(): Promise<RpcClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(SOCK)
      s.once('connect', () => resolve(s))
      s.once('error', reject)
    })
    return new RpcClient(socket)
  }

  request(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 5000)
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method: string, params: unknown = {}): void {
    this.socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async handshake(): Promise<Record<string, unknown>> {
    const res = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    })
    this.notify('notifications/initialized')
    return res
  }

  close(): void {
    this.socket.destroy()
  }
}

function textOf(response: Record<string, unknown>): string {
  const result = response['result'] as { content?: { text?: string }[] } | undefined
  return result?.content?.[0]?.text ?? ''
}

function isError(response: Record<string, unknown>): boolean {
  return Boolean((response['result'] as { isError?: boolean } | undefined)?.isError)
}

let handle: McpSocketHandle

beforeAll(async () => {
  getTgDb()
  // No live client: exercises the offline path every tool must handle.
  handle = startMcpSocket(() => null)
  await new Promise(r => setTimeout(r, 150))
})

afterAll(async () => {
  await handle.close()
  closeTgDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  const d = getTgDb()
  d.exec('DELETE FROM tg_messages')
  d.exec('DELETE FROM tg_messages_fts')
  d.exec('DELETE FROM tg_chats')
  d.exec('DELETE FROM tg_outbox')
})

describe('socket transport', () => {
  it('creates the socket with owner-only permissions', () => {
    expect(existsSync(SOCK)).toBe(true)
    // 0o600 — the same guard as telegram.session, and the reason we avoid TCP.
    expect(statSync(SOCK).mode & 0o777).toBe(0o600)
  })

  it('completes an MCP handshake', async () => {
    const client = await RpcClient.open()
    const res = await client.handshake()
    const result = res['result'] as { serverInfo?: { name?: string } }
    expect(result.serverInfo?.name).toBe('telegram-observer')
    client.close()
  })

  it('serves several connections in parallel', async () => {
    const a = await RpcClient.open()
    const b = await RpcClient.open()
    await Promise.all([a.handshake(), b.handshake()])
    expect(handle.connections()).toBeGreaterThanOrEqual(2)
    const [ra, rb] = await Promise.all([a.request('tools/list'), b.request('tools/list')])
    expect((ra['result'] as { tools: unknown[] }).tools.length).toBeGreaterThan(0)
    expect((rb['result'] as { tools: unknown[] }).tools.length).toBeGreaterThan(0)
    a.close()
    b.close()
  })
})

describe('tools', () => {
  let client: RpcClient

  beforeEach(async () => {
    client = await RpcClient.open()
    await client.handshake()
  })

  it('advertises the read and send tools', async () => {
    const res = await client.request('tools/list')
    const names = (res['result'] as { tools: { name: string }[] }).tools.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'tg_list_chats', 'tg_unread', 'tg_read_chat', 'tg_search',
      'tg_resolve', 'tg_send_message', 'tg_send_file', 'tg_mark_read',
    ]))
    client.close()
  })

  it('lists chats from the log', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    const res = await client.request('tools/call', { name: 'tg_list_chats', arguments: {} })
    expect(textOf(res)).toContain('Петро')
    client.close()
  })

  it('reports unread chats', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    setChatUnread('111', 4)
    const res = await client.request('tools/call', { name: 'tg_unread', arguments: {} })
    expect(textOf(res)).toContain('4 непрочитаних')
    client.close()
  })

  it('reads a chat from the log when Telegram is offline', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', sender_name: 'Петро', text: 'зустріч о 15', ts: 1000 })
    const res = await client.request('tools/call', {
      name: 'tg_read_chat', arguments: { chat: '111', from_log: true },
    })
    expect(textOf(res)).toContain('зустріч о 15')
    client.close()
  })

  it('refuses a live read when the client is down, and says why', async () => {
    const res = await client.request('tools/call', {
      name: 'tg_read_chat', arguments: { chat: '111' },
    })
    expect(isError(res)).toBe(true)
    expect(textOf(res)).toContain('from_log=true')
    client.close()
  })

  it('searches the archive', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'out', text: 'надішлю кошторис у четвер', ts: 1000 })
    const res = await client.request('tools/call', {
      name: 'tg_search', arguments: { query: 'кошторис' },
    })
    expect(textOf(res)).toContain('кошторис')
    client.close()
  })

  it('rejects an unknown tool by name', async () => {
    const res = await client.request('tools/call', { name: 'tg_nonexistent', arguments: {} })
    expect(isError(res)).toBe(true)
    client.close()
  })
})

describe('send gate', () => {
  let client: RpcClient

  beforeEach(async () => {
    client = await RpcClient.open()
    await client.handshake()
  })

  it('refuses to send to a chat that is not in the registry', async () => {
    const res = await client.request('tools/call', {
      name: 'tg_send_message', arguments: { chat: '999', text: 'привіт' },
    })
    expect(isError(res)).toBe(true)
    expect(textOf(res)).toContain('не знайдено в реєстрі')
    client.close()
  })

  it('refuses a known chat that is not allowlisted for sending', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    const res = await client.request('tools/call', {
      name: 'tg_send_message', arguments: { chat: '111', text: 'привіт' },
    })
    expect(isError(res)).toBe(true)
    expect(textOf(res)).toContain('не дозволена')
    client.close()
  })

  it('refuses an empty message before touching the allowlist', async () => {
    const res = await client.request('tools/call', {
      name: 'tg_send_message', arguments: { chat: '111', text: '   ' },
    })
    expect(isError(res)).toBe(true)
    expect(textOf(res)).toContain('Порожній текст')
    client.close()
  })

  it('enforces the hourly limit even for an allowlisted chat', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    setChatCanSend('111', true)
    for (let i = 0; i < 10; i++) {
      recordOutbox({ chat_id: '111', kind: 'message', text: `m${i}`, status: 'sent' })
    }
    const res = await client.request('tools/call', {
      name: 'tg_send_message', arguments: { chat: '111', text: 'ще одне' },
    })
    expect(isError(res)).toBe(true)
    expect(textOf(res)).toContain('на годину')
    client.close()
  })

  it('advertises mark_read so a reply does not leave the thread unread', async () => {
    const res = await client.request('tools/list')
    const tools = (res['result'] as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools
    for (const name of ['tg_send_message', 'tg_send_file']) {
      const tool = tools.find(t => t.name === name)!
      expect(Object.keys(tool.inputSchema.properties), name).toContain('mark_read')
    }
    client.close()
  })

  it('does not record an outbox entry for a refused send', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    await client.request('tools/call', {
      name: 'tg_send_message', arguments: { chat: '111', text: 'привіт' },
    })
    expect(listOutbox()).toHaveLength(0)
    client.close()
  })
})
