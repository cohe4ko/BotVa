#!/usr/bin/env node
/**
 * telegram-mcp — a pipe, not a server.
 *
 * MCP over stdio is newline-delimited JSON-RPC, and the Telegram Observer daemon
 * speaks the same framing on its Unix socket. So this shim moves bytes and
 * nothing else: tool schemas live in the daemon (src/telegram/mcp.ts) and adding
 * a tool there needs no rebuild here.
 *
 * Contrast with mcp-servers/colleague, which must declare its own tools because
 * the far side of colleague.sock speaks an application protocol, not MCP.
 */

import * as net from 'node:net'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Resolve the project root from this file's own location
// (mcp-servers/telegram/build/index.js → three levels up), not from the
// environment: bots do not export PROJECT_ROOT, and cwd is not guaranteed.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = process.env['PROJECT_ROOT'] || path.resolve(__dirname, '..', '..', '..')
const SOCK_PATH = path.resolve(PROJECT_ROOT, 'store', 'telegram.sock')

/**
 * Report a startup failure as a JSON-RPC error to whatever request arrives,
 * instead of dying silently or hanging until the client times out.
 */
function failFast(reason: string): void {
  let buffer = ''
  process.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let id: unknown = null
      try { id = (JSON.parse(line) as { id?: unknown }).id ?? null } catch { /* malformed, still answer */ }
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: reason },
      }) + '\n')
    }
  })
  console.error(`[telegram-mcp] ${reason}`)
}

if (!existsSync(SOCK_PATH)) {
  failFast('Telegram Observer не запущений (сокет не знайдено). Запусти його в адмінці: Telegram → Підключення.')
} else {
  const client = net.connect(SOCK_PATH)

  client.on('connect', () => {
    process.stdin.pipe(client)
    client.pipe(process.stdout)
  })

  client.on('error', (err: Error) => {
    failFast(`Не вдалось під'єднатись до Telegram Observer: ${err.message}`)
  })

  client.on('close', () => {
    process.exit(0)
  })

  process.on('SIGINT', () => { client.end(); process.exit(0) })
  process.on('SIGTERM', () => { client.end(); process.exit(0) })
}
