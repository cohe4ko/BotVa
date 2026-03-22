#!/usr/bin/env npx tsx
/**
 * Run a scheduled task manually with full console output.
 * Usage: BOT_NAME=cap npx tsx scripts/run-task.ts [task-id]
 * If no task-id, runs the first active task.
 */

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// Set up env
process.env.PROJECT_ROOT = PROJECT_ROOT
const BOT_NAME = process.env.BOT_NAME ?? 'cap'
process.env.BOT_NAME = BOT_NAME

// Load bot .env
const { readEnvFile } = await import(resolve(PROJECT_ROOT, 'dist/env.js'))
const env = readEnvFile()
Object.assign(process.env, env)

// Init DB
const { initDatabase, getDueTasks, listTasks, updateTaskAfterRun } = await import(resolve(PROJECT_ROOT, 'dist/db.js'))
initDatabase()

// Find task
const taskId = process.argv[2]
const allTasks = listTasks()
const task = taskId
  ? allTasks.find((t: any) => t.id === taskId || t.id.startsWith(taskId))
  : allTasks.find((t: any) => t.status === 'active')

if (!task) {
  console.error('No task found. Available tasks:')
  allTasks.forEach((t: any) => console.log(`  ${t.id} [${t.status}] ${t.prompt.slice(0, 60)}`))
  process.exit(1)
}

console.log(`\n🎯 Task: ${task.id}`)
console.log(`📝 Prompt: ${task.prompt}`)
console.log(`📅 Schedule: ${task.schedule}`)
console.log(`---\n`)

// Create builtin MCP (minimal set)
const { Bot } = await import('grammy')
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TELEGRAM_BOT_TOKEN) { console.error('No TELEGRAM_BOT_TOKEN'); process.exit(1) }

const bot = new Bot(TELEGRAM_BOT_TOKEN)

function createCtx(api: any, chatId: number): any {
  return {
    chat: { id: chatId },
    message: undefined,
    api,
    reply: (text: string, opts?: any) => api.sendMessage(chatId, text, opts),
    replyWithChatAction: (action: any) => api.sendChatAction(chatId, action),
    replyWithPhoto: (input: any, opts?: any) => api.sendPhoto(chatId, input, opts),
    replyWithVoice: (input: any, opts?: any) => api.sendVoice(chatId, input, opts),
    replyWithDocument: (input: any, opts?: any) => api.sendDocument(chatId, input, opts),
    replyWithVideo: (input: any, opts?: any) => api.sendVideo(chatId, input, opts),
    replyWithMediaGroup: (media: any) => api.sendMediaGroup(chatId, media),
    replyWithSticker: (sticker: any) => api.sendSticker(chatId, sticker),
    replyWithAnimation: (input: any, opts?: any) => api.sendAnimation(chatId, input, opts),
    replyWithLocation: (lat: number, lon: number) => api.sendLocation(chatId, lat, lon),
    replyWithVenue: (lat: number, lon: number, title: string, addr: string, opts?: any) =>
      api.sendVenue(chatId, lat, lon, title, addr, opts),
  }
}

const SCHEDULER_TOOLS = [
  'SearchMemory', 'SaveFact', 'GetCurrentTime',
  'SendMedia', 'TextToSpeech', 'PublishTelegraph',
  'GenerateImage', 'CurrencyRates', 'RunPython',
  'ReadWorkspaceFile',
]

let builtinServer: any = undefined
try {
  const { createBuiltinMcpServer } = await import(resolve(PROJECT_ROOT, 'dist/builtin-tools.js'))
  const ctx = createCtx(bot.api, Number(task.chat_id))
  const builtin = await createBuiltinMcpServer(ctx, Number(task.chat_id), undefined, SCHEDULER_TOOLS)
  builtinServer = builtin?.server
  console.log('✅ Builtin MCP created with tools:', SCHEDULER_TOOLS.join(', '))
} catch (err) {
  console.error('⚠️ Failed to create builtin MCP:', err)
}

// Run agent
console.log('\n🚀 Running agent...\n')

const { runAgent } = await import(resolve(PROJECT_ROOT, 'dist/agent.js'))

// Event handler to show progress
const onEvent = (event: any) => {
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text') {
        process.stdout.write(`\n💬 ${block.text.slice(0, 200)}\n`)
      } else if (block.type === 'tool_use') {
        console.log(`🔧 ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`)
      }
    }
  } else if (event.type === 'result') {
    console.log(`\n📊 Result type: ${event.subtype}`)
  }
}

const { text, usage } = await runAgent(
  task.prompt, undefined, undefined, task.chat_id,
  onEvent, undefined, builtinServer, undefined, undefined, []
)

console.log('\n---')
console.log(`📋 Result: ${text?.slice(0, 500) ?? '(null)'}`)
if (usage) {
  console.log(`💰 Cost: $${usage.costUSD?.toFixed(4)}`)
  console.log(`📏 Context: ${usage.lastTurnContextTokens}/${usage.contextWindow} tokens`)
}

process.exit(0)
