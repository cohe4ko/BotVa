import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createServer as createNetServer, type Server as NetServer } from 'net'
import { STORE_DIR, TELEGRAM_BOT_TOKEN, TELEGRAPH_ENABLED, BOT_NAME, PROJECT_ROOT, ALLOWED_CHAT_ID } from './config.js'
import { runAgent } from './agent.js'
import { getManagerName } from './team.js'
import { initDatabase, getChatSetting } from './db.js'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads, ensureUploadsDir } from './media.js'
import { createBot, sendMessage, startRelayListener } from './bot.js'
import { run, sequentialize } from '@grammyjs/runner'
import { initScheduler, stopScheduler } from './scheduler.js'
import { logger } from './logger.js'
import { getConsolidationHour } from './system-settings.js'
import { preventSleep, allowSleep } from './caffeinate.js'
import { stopDeduplication } from './deduplication.js'
import { initTelegraph } from './telegraph.js'
import { runDailyConsolidation } from './consolidate.js'

const PID_FILE = join(STORE_DIR, 'botva.pid')
const SOCK_PATH = join(STORE_DIR, 'colleague.sock')
let socketServer: NetServer | null = null

function startSocketListener(): void {
  if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH)

  socketServer = createNetServer((conn) => {
    let data = ''
    const timeout = setTimeout(() => { conn.destroy() }, 120_000)

    conn.on('data', (chunk) => {
      data += chunk.toString()
      const nlIndex = data.indexOf('\n')
      if (nlIndex === -1) return

      clearTimeout(timeout)
      const line = data.slice(0, nlIndex)

      let req: { question: string; from: string; sessionId?: string; newSession?: boolean; timeout?: number }
      try {
        req = JSON.parse(line)
      } catch {
        conn.write(JSON.stringify({ error: 'Invalid JSON' }) + '\n')
        conn.end()
        return
      }

      // Dynamic timeout: restart with caller-specified value
      if (req.timeout && req.timeout > 0) {
        clearTimeout(timeout)
        const dynTimeout = setTimeout(() => { conn.destroy() }, req.timeout)
        conn.on('close', () => clearTimeout(dynTimeout))
      }

      const managerName = getManagerName(PROJECT_ROOT)
      const isFromManager = managerName && req.from === managerName
      const antiRecursionNote = !isFromManager ? '' :
        '\n\n[SYSTEM: Ти відповідаєш на запит колеги. НЕ використовуй ask_manager.]'

      const showWork = ALLOWED_CHAT_ID ? getChatSetting(ALLOWED_CHAT_ID, 'show_team_work') : null

      if (showWork === 'all' || showWork === 'result') {
        sendMessage(ALLOWED_CHAT_ID!, `📨 Запит від ${req.from}: ${req.question}`).catch(() => {})
      }

      // Session: caller can pass sessionId or request newSession
      const sessionId = req.newSession ? undefined : (req.sessionId || undefined)

      // Stream status updates to caller
      const onEvent = (event: import('@anthropic-ai/claude-agent-sdk').SDKMessage) => {
        if (conn.destroyed) return
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content as any[]) {
            if (block.type === 'tool_use') {
              conn.write(JSON.stringify({ status: `🔧 ${block.name}` }) + '\n')
            }
          }
        }
      }

      runAgent(req.question + antiRecursionNote, sessionId, undefined, 'colleague-' + req.from, onEvent)
        .then(({ text, newSessionId }) => {
          if (showWork === 'all' || showWork === 'result') {
            const preview = (text ?? '').slice(0, 500)
            sendMessage(ALLOWED_CHAT_ID!, `✅ Відповідь для ${req.from}: ${preview}`).catch(() => {})
          }
          conn.write(JSON.stringify({ answer: text ?? 'Немає відповіді', sessionId: newSessionId }) + '\n')
          conn.end()
        })
        .catch((err) => {
          conn.write(JSON.stringify({ error: String(err) }) + '\n')
          conn.end()
        })
    })

    conn.on('error', () => { clearTimeout(timeout) })
  })

  socketServer.listen(SOCK_PATH, () => {
    logger.info({ sock: SOCK_PATH }, 'Colleague socket listening')
  })
}

function stopSocketListener(): void {
  socketServer?.close()
  try { unlinkSync(SOCK_PATH) } catch {}
}

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true })

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (oldPid && !isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0) // check if alive
        logger.warn({ oldPid }, 'Killing stale process')
        process.kill(oldPid, 'SIGTERM')
      } catch {
        // Process not running, stale PID file
      }
    }
  }

  writeFileSync(PID_FILE, String(process.pid))
  logger.debug({ pid: process.pid }, 'Lock acquired')
}

function releaseLock(): void {
  try {
    unlinkSync(PID_FILE)
  } catch { /* ignore */ }
}

async function main(): Promise<void> {
  console.log(`
██████╗  ██████╗ ████████╗██╗   ██╗ █████╗
██╔══██╗██╔═══██╗╚══██╔══╝██║   ██║██╔══██╗
██████╔╝██║   ██║   ██║   ██║   ██║███████║
██╔══██╗██║   ██║   ██║   ╚██╗ ██╔╝██╔══██║
██████╔╝╚██████╔╝   ██║    ╚████╔╝ ██║  ██║
╚═════╝  ╚═════╝    ╚═╝     ╚═══╝  ╚═╝  ╚═╝
`)

  // Check required config
  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN не встановлений. Запусти: npm run setup')
    process.exit(1)
  }

  // Acquire lock
  acquireLock()

  // Prevent macOS sleep
  preventSleep()

  // Initialize database
  initDatabase()

  // Initialize Telegraph
  if (TELEGRAPH_ENABLED) {
    initTelegraph().catch(err => logger.error({ err }, 'Telegraph init failed'))
  }

  // Background embedding migration for existing facts
  import('./embeddings.js').then(({ isReady, embedBatch }) => {
    isReady().then(ready => {
      if (!ready) return
      import('./db.js').then(({ getFactsWithoutEmbeddings, updateFactEmbedding }) => {
        const chatId = ALLOWED_CHAT_ID
        if (!chatId) return
        const facts = getFactsWithoutEmbeddings(chatId, 50)
        if (facts.length === 0) return
        logger.info({ count: facts.length }, 'Background embedding migration starting')
        embedBatch(facts.map(f => f.content), 'passage').then(vecs => {
          for (let i = 0; i < facts.length; i++) {
            if (vecs[i]) updateFactEmbedding(facts[i].id, vecs[i]!)
          }
          logger.info({ count: facts.length }, 'Background embedding migration done')
        }).catch(err => logger.warn({ err }, 'Background embedding migration failed'))
      })
    })
  }).catch(() => {})

  // Run memory decay sweep on startup + daily
  runDecaySweep()
  const decayInterval = setInterval(runDecaySweep, 24 * 60 * 60 * 1000)

  // Schedule daily consolidation (recursive setTimeout to avoid drift)
  const scheduleConsolidation = () => {
    const hour = getConsolidationHour()
    const now = new Date()
    const next = new Date(now)
    next.setHours(hour, 0, 0, 0)
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1)
    }
    const delay = next.getTime() - now.getTime()
    logger.info({ nextRun: next.toISOString(), delayMs: delay }, 'Consolidation scheduled')

    setTimeout(async () => {
      try {
        await runDailyConsolidation(sendMessage)
      } catch (err) {
        logger.error({ err }, 'Daily consolidation failed')
      }
      scheduleConsolidation()
    }, delay)
  }
  scheduleConsolidation()

  // Cleanup old uploads
  ensureUploadsDir()
  cleanupOldUploads()

  // Create bot with concurrent update processing
  const bot = createBot()

  // Sequentialize: messages in same chat run sequentially,
  // but callback queries (stop button) run independently
  bot.use(sequentialize((ctx) => {
    // Callback queries (stop button) get their own lane — run immediately
    if (ctx.callbackQuery) return `cb:${ctx.update.update_id}`
    // /cancel also gets its own lane
    if (ctx.message?.text === '/cancel') return `cancel:${ctx.update.update_id}`
    // Everything else is sequentialized by chat ID
    return String(ctx.chat?.id ?? ctx.update.update_id)
  }))

  // Init scheduler
  initScheduler(sendMessage)

  // Start relay listener for bot-to-bot communication in groups
  const stopRelay = startRelayListener(bot)

  // Start colleague socket listener
  startSocketListener()

  // Start bot with concurrent runner
  logger.info('BotVa запускається...')
  const runner = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ['message', 'callback_query', 'my_chat_member', 'poll_answer'],
      },
    },
  })

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Завершення роботи...')
    try {
      const { stopAdmin } = await import('./admin/on-demand.js')
      stopAdmin()
    } catch {}
    try {
      const { persistentMcp } = await import('./persistent-mcp.js')
      persistentMcp.stopAll()
    } catch {}
    stopRelay()
    stopSocketListener()
    stopScheduler()
    stopDeduplication()
    clearInterval(decayInterval)
    allowSleep()
    runner.stop()
    releaseLock()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Catch unhandled rejections from SDK internals (e.g. ProcessTransport race conditions)
  // so they don't crash the entire bot process
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    if (msg.includes('not ready for writing') || msg.includes('terminated process') || msg.includes('Cannot write to')) {
      logger.warn({ err: reason }, 'SDK transport error (suppressed)')
    } else {
      logger.error({ err: reason }, 'Unhandled rejection')
    }
  })

  // Wait for runner to finish (keeps process alive)
  await runner.task()
}

main()
