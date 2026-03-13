#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import * as net from 'node:net'
import * as path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const PROJECT_ROOT = process.env.PROJECT_ROOT || ''
const BOT_NAME = process.env.BOT_NAME || 'unknown'

function getManagerBot(): string {
  const teamPath = path.resolve(PROJECT_ROOT, 'workspace', 'team.json')
  try {
    const data = JSON.parse(readFileSync(teamPath, 'utf-8'))
    return data.manager || ''
  } catch {
    return ''
  }
}

function askManager(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const manager = getManagerBot()
    if (!manager) {
      reject(new Error('Менеджер не призначений (workspace/team.json)'))
      return
    }

    const sockPath = path.resolve(PROJECT_ROOT, 'bots', manager, 'store', 'colleague.sock')

    if (!existsSync(sockPath)) {
      reject(new Error(`Керівник (${manager}) не запущений`))
      return
    }

    const client = net.connect(sockPath)
    let data = ''

    const timeout = setTimeout(() => {
      client.destroy()
      reject(new Error('Керівник не відповів за 120 секунд'))
    }, 120_000)

    client.on('connect', () => {
      client.write(JSON.stringify({ question, from: BOT_NAME }) + '\n')
    })

    client.on('data', (chunk) => {
      data += chunk.toString()
      const nlIndex = data.indexOf('\n')
      if (nlIndex !== -1) {
        clearTimeout(timeout)
        const line = data.slice(0, nlIndex)
        client.end()
        try {
          const resp = JSON.parse(line)
          if (resp.error) {
            reject(new Error(resp.error))
          } else {
            resolve(resp.answer || '')
          }
        } catch {
          reject(new Error('Невалідна відповідь від керівника'))
        }
      }
    })

    client.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`Помилка з'єднання з керівником: ${err.message}`))
    })
  })
}

const server = new Server(
  { name: 'manager-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ask_manager',
      description: 'Звернутись до керівника команди. Він може делегувати задачу іншому боту або відповісти сам.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          question: { type: 'string', description: 'Питання або прохання для керівника' },
        },
        required: ['question'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name !== 'ask_manager') {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }

  const question = args?.question as string

  if (!question) {
    return { content: [{ type: 'text', text: 'Потрібен параметр: question' }], isError: true }
  }

  try {
    console.error(`[manager-mcp] ${BOT_NAME} asks manager: ${question.slice(0, 100)}...`)
    const answer = await askManager(question)
    console.error(`[manager-mcp] Manager answered (${answer.length} chars)`)
    return { content: [{ type: 'text', text: answer }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[manager-mcp] Error: ${msg}`)
    return { content: [{ type: 'text', text: msg }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
