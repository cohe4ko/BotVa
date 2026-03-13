#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import * as net from 'node:net'
import * as path from 'node:path'
import { existsSync } from 'node:fs'

const PROJECT_ROOT = process.env.PROJECT_ROOT || ''

// Session storage per bot
const sessions = new Map<string, string>()

interface AskResult {
  answer: string
  sessionId?: string
  statuses: string[]
}

const DEFAULT_TIMEOUT_MS = 120_000

function askBot(bot: string, question: string, opts?: { newSession?: boolean; timeoutMs?: number }): Promise<AskResult> {
  return new Promise((resolve, reject) => {
    const sockPath = path.resolve(PROJECT_ROOT, 'bots', bot, 'store', 'colleague.sock')

    if (!existsSync(sockPath)) {
      reject(new Error(`Бот "${bot}" не запущений (socket не знайдено)`))
      return
    }

    const client = net.connect(sockPath)
    let data = ''
    const statuses: string[] = []
    const effectiveTimeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const timeout = setTimeout(() => {
      client.destroy()
      reject(new Error(`Бот "${bot}" не відповів за ${Math.round(effectiveTimeout / 1000)} секунд`))
    }, effectiveTimeout)

    client.on('connect', () => {
      const payload: Record<string, unknown> = { question, from: 'orchestrator' }
      if (opts?.newSession) {
        payload.newSession = true
      } else {
        const sid = sessions.get(bot)
        if (sid) payload.sessionId = sid
      }
      if (effectiveTimeout !== DEFAULT_TIMEOUT_MS) {
        payload.timeout = effectiveTimeout
      }
      client.write(JSON.stringify(payload) + '\n')
    })

    client.on('data', (chunk) => {
      data += chunk.toString()
      // Process all complete lines
      let nlIndex: number
      while ((nlIndex = data.indexOf('\n')) !== -1) {
        const line = data.slice(0, nlIndex)
        data = data.slice(nlIndex + 1)
        try {
          const resp = JSON.parse(line)
          if (resp.status) {
            // Intermediate status update
            statuses.push(resp.status)
            console.error(`[colleague-mcp] ${bot} status: ${resp.status}`)
            continue
          }
          if (resp.error) {
            clearTimeout(timeout)
            client.end()
            reject(new Error(resp.error))
            return
          }
          // Final answer
          clearTimeout(timeout)
          client.end()
          if (resp.sessionId) sessions.set(bot, resp.sessionId)
          resolve({ answer: resp.answer || '', sessionId: resp.sessionId, statuses })
          return
        } catch {
          clearTimeout(timeout)
          client.end()
          reject(new Error('Невалідна відповідь від бота'))
          return
        }
      }
    })

    client.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`Помилка з'єднання з ботом "${bot}": ${err.message}`))
    })
  })
}

const server = new Server(
  { name: 'colleague-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ask_colleague',
      description: 'Запитати бота-колегу. Використовуй для делегування задачі одному боту. Сесія зберігається автоматично — бот пам\'ятає контекст попередніх запитів.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bot: { type: 'string', description: "Ім'я бота" },
          question: { type: 'string', description: 'Питання або задача для бота' },
          new_session: { type: 'boolean', description: 'true — почати нову сесію (скинути контекст бота)' },
          timeout: { type: 'number', description: 'Таймаут в секундах (за замовчуванням 120). Для складних задач з субагентами — 300-600.' },
        },
        required: ['bot', 'question'],
      },
    },
    {
      name: 'ask_colleagues',
      description: 'Запитати кількох ботів ПАРАЛЕЛЬНО. Використовуй коли потрібно делегувати задачі декільком ботам одночасно — значно швидше ніж послідовні виклики ask_colleague.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          requests: {
            type: 'array',
            description: 'Масив запитів до ботів',
            items: {
              type: 'object',
              properties: {
                bot: { type: 'string', description: "Ім'я бота" },
                question: { type: 'string', description: 'Питання або задача' },
                new_session: { type: 'boolean', description: 'true — почати нову сесію' },
                timeout: { type: 'number', description: 'Таймаут в секундах' },
              },
              required: ['bot', 'question'],
            },
          },
        },
        required: ['requests'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'ask_colleague') {
    const bot = args?.bot as string
    const question = args?.question as string
    const newSession = args?.new_session as boolean | undefined
    const timeoutSec = args?.timeout as number | undefined
    const timeoutMs = timeoutSec ? timeoutSec * 1000 : undefined

    if (!bot || !question) {
      return { content: [{ type: 'text', text: 'Потрібні параметри: bot, question' }], isError: true }
    }

    try {
      console.error(`[colleague-mcp] Asking ${bot}: ${question.slice(0, 100)}...${newSession ? ' (new session)' : sessions.has(bot) ? ` (session: ${sessions.get(bot)!.slice(0, 8)}...)` : ' (no session)'}${timeoutSec ? ` (timeout: ${timeoutSec}s)` : ''}`)
      const result = await askBot(bot, question, { newSession, timeoutMs })
      console.error(`[colleague-mcp] ${bot} answered (${result.answer.length} chars, ${result.statuses.length} status updates)`)
      const statusLog = result.statuses.length > 0
        ? `\n\n[Виконані кроки: ${result.statuses.join(' → ')}]`
        : ''
      return { content: [{ type: 'text', text: result.answer + statusLog }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[colleague-mcp] Error: ${msg}`)
      return { content: [{ type: 'text', text: msg }], isError: true }
    }
  }

  if (name === 'ask_colleagues') {
    const requests = args?.requests as Array<{ bot: string; question: string; new_session?: boolean; timeout?: number }>

    if (!requests || !Array.isArray(requests) || requests.length === 0) {
      return { content: [{ type: 'text', text: 'Потрібен непустий масив requests' }], isError: true }
    }

    console.error(`[colleague-mcp] Asking ${requests.length} bots in parallel: ${requests.map(r => r.bot).join(', ')}`)

    const results = await Promise.allSettled(
      requests.map(async (r) => {
        const result = await askBot(r.bot, r.question, { newSession: r.new_session, timeoutMs: r.timeout ? r.timeout * 1000 : undefined })
        console.error(`[colleague-mcp] ${r.bot} answered (${result.answer.length} chars, ${result.statuses.length} status updates)`)
        const statusLog = result.statuses.length > 0
          ? `\n\n[Виконані кроки: ${result.statuses.join(' → ')}]`
          : ''
        return { bot: r.bot, answer: result.answer + statusLog }
      })
    )

    const parts = results.map((result, i) => {
      const bot = requests[i].bot
      if (result.status === 'fulfilled') {
        return `=== ${bot} ===\n${result.value.answer}`
      } else {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason)
        console.error(`[colleague-mcp] ${bot} error: ${msg}`)
        return `=== ${bot} (ПОМИЛКА) ===\n${msg}`
      }
    })

    return { content: [{ type: 'text', text: parts.join('\n\n') }] }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
})

const transport = new StdioServerTransport()
await server.connect(transport)
