/**
 * Bot diagnostic mode — runs the agent with FULL real context and outputs echo as JSON.
 *
 * Usage: BOT_NAME=mybot npx tsx src/diagnostic.ts
 *
 * This starts the bot's full environment (DB, builtin tools with real Telegram ctx,
 * MCP servers, CLAUDE.md) but instead of listening for messages, runs a single
 * diagnostic echo prompt and exits.
 *
 * Output: JSON to stdout with { echoText, usage, error? }
 */

import { Bot } from 'grammy'
import { TELEGRAM_BOT_TOKEN, STORE_DIR, BOT_NAME, PROJECT_ROOT, TELEGRAPH_ENABLED } from './config.js'
import { initDatabase } from './db.js'
import { createBuiltinMcpServer } from './builtin-tools.js'
import { buildMcpServers } from './mcp-config.js'
import { isManager } from './team.js'
import { initTelegraph } from './telegraph.js'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { readEnvFile, BOT_DIR } from './env.js'
import { mkdirSync } from 'fs'

const ECHO_PROMPT = `You are running in diagnostic mode. Your task is to list EVERYTHING available to you in detail.

Output the following sections:

## Tools
List ALL tools available to you. For each tool, write:
- Tool name
- Brief description (one sentence)
- Which MCP server or source it belongs to (e.g. "builtin", "sdk", the MCP server name)

## MCP Servers
List all MCP servers you can see connected, with their names.

## System Instructions
Summarize the key points from your system instructions (CLAUDE.md and any other instructions you received).

## Role & Personality
Describe your configured role and personality.

## Knowledge
List any knowledge files, context documents, or other data you have access to.

## Skills
If you see any skills (slash commands like /commit, /review-pr, /simplify, etc.) in your instructions, list them with their names and what they do.

Be exhaustive and precise. Do NOT call any tools — just describe what you see in your context.`

interface DiagResult {
  echoText: string
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUSD: number
  }
  error?: string
}

async function main(): Promise<void> {
  // Ensure store dir exists
  mkdirSync(STORE_DIR, { recursive: true })

  // Initialize database (needed for memory context etc.)
  initDatabase()

  // Initialize Telegraph if enabled
  if (TELEGRAPH_ENABLED) {
    await initTelegraph().catch(() => {})
  }

  // Create a real Telegram bot instance (for builtin tools context)
  if (!TELEGRAM_BOT_TOKEN) {
    const result: DiagResult = { echoText: '', error: 'No TELEGRAM_BOT_TOKEN configured' }
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exit(1)
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN)
  await bot.init()

  // We need a real grammy Context for createBuiltinMcpServer.
  const fakeUpdate = {
    update_id: 0,
    message: {
      message_id: 0,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 0, type: 'private' as const, first_name: 'diagnostic' },
      from: { id: 0, is_bot: false, first_name: 'diagnostic' },
      text: 'diagnostic',
    },
  } as any
  const { Context } = await import('grammy')
  const ctx = new Context(fakeUpdate, bot.api, bot.botInfo)

  // Build MCP servers
  const env = readEnvFile()
  const mcpServers: Record<string, any> = buildMcpServers(env)

  // Add builtin tools with real Telegram context
  const builtin = createBuiltinMcpServer(ctx, 0)
  if (builtin) {
    mcpServers['builtin'] = builtin.server
  }

  // Add inter-bot communication
  if (BOT_NAME && isManager(PROJECT_ROOT, BOT_NAME)) {
    mcpServers['colleague'] = {
      command: 'node',
      args: [`${PROJECT_ROOT}/mcp-servers/colleague/build/index.js`],
      env: { ...process.env as Record<string, string>, PROJECT_ROOT },
    }
  } else if (BOT_NAME) {
    mcpServers['manager'] = {
      command: 'node',
      args: [`${PROJECT_ROOT}/mcp-servers/manager/build/index.js`],
      env: { ...process.env as Record<string, string>, PROJECT_ROOT, BOT_NAME },
    }
  }

  // Run the echo query
  let echoText = ''
  let usage: DiagResult['usage']

  try {
    const conversation = query({
      prompt: ECHO_PROMPT,
      options: {
        cwd: BOT_DIR,
        permissionMode: 'bypassPermissions',
        mcpServers,
        canUseTool: async () => ({ behavior: 'deny' as const, message: 'Diagnostic mode — tool use disabled' }),
        model: 'sonnet',
      },
    })

    for await (const event of conversation) {
      if (event.type === 'result') {
        echoText = event.subtype === 'success' ? event.result : (event.errors?.join('\n') ?? 'Error')
        const models = Object.values(event.modelUsage ?? {})
        if (models.length > 0) {
          const totals = models.reduce(
            (acc: any, m: any) => ({
              inputTokens: acc.inputTokens + m.inputTokens,
              outputTokens: acc.outputTokens + m.outputTokens,
              cacheReadTokens: acc.cacheReadTokens + m.cacheReadInputTokens,
              cacheCreationTokens: acc.cacheCreationTokens + m.cacheCreationInputTokens,
              costUSD: acc.costUSD + m.costUSD,
            }),
            { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0 }
          )
          usage = totals
        }
      }
    }

    const result: DiagResult = { echoText, usage }
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const result: DiagResult = { echoText, usage, error: msg }
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exit(1)
  }

  process.exit(0)
}

main()
