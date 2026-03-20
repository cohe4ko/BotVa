import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { authMiddleware, setAuthCookie, loginPage } from './auth.js'
import { i18nMiddleware, type I18nEnv } from './i18n.js'
import dashboard from './routes/dashboard.js'
import botConfig from './routes/bot-config.js'
import botKnowledge from './routes/bot-knowledge.js'
import botTasks from './routes/bot-tasks.js'
import botSettings from './routes/bot-settings.js'
import botFacts from './routes/bot-facts.js'
import botUsage from './routes/bot-usage.js'
import botImages from './routes/bot-images.js'
import botLogs from './routes/bot-logs.js'
import system from './routes/system.js'
import createBot from './routes/create-bot.js'
import gallery from './routes/gallery.js'
import storage from './routes/storage.js'
import backup from './routes/backup.js'
import team from './routes/team.js'
import botDiagnostics from './routes/bot-diagnostics.js'
import diagnostics from './routes/diagnostics.js'
import docs from './routes/docs.js'
import templates from './routes/templates.js'
import terminal from './routes/terminal.js'
import records from './routes/records.js'
import { attachTerminalWS } from './terminal-ws.js'

export function createAdminApp(): Hono<I18nEnv> {
  const app = new Hono<I18nEnv>()

  // Static files
  app.use('/static/*', serveStatic({ root: 'src/admin/' }))
  app.use('/gallery-img/*', serveStatic({ root: 'workspace/', rewriteRequestPath: (path) => path.replace('/gallery-img/', '/gallery/') }))
  app.use('/gallery-thumb/*', serveStatic({ root: 'workspace/', rewriteRequestPath: (path) => path.replace('/gallery-thumb/', '/gallery/thumbs/') }))
  app.use('/records-audio/*', serveStatic({ root: 'workspace/listener/', rewriteRequestPath: (path) => path.replace('/records-audio/', '/audio/') }))

  // Auth
  app.use('*', authMiddleware)

  // i18n
  app.use('*', i18nMiddleware)

  app.post('/login', async (c) => {
    const body = await c.req.parseBody()
    const token = String(body['token'] ?? '')
    if (setAuthCookie(c, token)) {
      return c.redirect('/')
    }
    const t = c.get('t')
    return c.html(loginPage(t('auth.invalid'), t))
  })

  // Routes
  app.route('/', dashboard)
  app.route('/', botConfig)
  app.route('/', botKnowledge)
  app.route('/', botTasks)
  app.route('/', botSettings)
  app.route('/', botFacts)
  app.route('/', botUsage)
  app.route('/', botImages)
  app.route('/', botLogs)
  app.route('/', system)
  app.route('/', createBot)
  app.route('/', gallery)
  app.route('/', records)
  app.route('/', storage)
  app.route('/', backup)
  app.route('/', team)
  app.route('/', botDiagnostics)
  app.route('/', diagnostics)
  app.route('/', docs)
  app.route('/', templates)
  app.route('/', terminal)

  return app
}

// Standalone mode: npm run admin
const isDirectRun = process.argv[1]?.includes('server')
if (isDirectRun) {
  const app = createAdminApp()
  const port = parseInt(process.env.ADMIN_PORT || '3000', 10)
  const IDLE_TIMEOUT_MS = 20 * 60 * 1000

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      console.log('\n  Admin panel: 20 min inactivity, shutting down...')
      process.exit(0)
    }, IDLE_TIMEOUT_MS)
  }

  // Wrap fetch to reset timer on authenticated requests (skip static)
  const originalFetch = app.fetch.bind(app)
  const wrappedFetch = (req: Request, ...args: any[]) => {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/static/')) resetIdleTimer()
    return originalFetch(req, ...args)
  }

  // Prevent crashes from killing admin
  process.on('uncaughtException', (err) => {
    console.error('Admin uncaughtException:', err)
  })
  process.on('unhandledRejection', (err) => {
    console.error('Admin unhandledRejection:', err)
  })

  resetIdleTimer()
  const host = process.env.ADMIN_HOST || `http://localhost:${port}`
  console.log(`\n  BotVa Admin Panel\n  ${host}\n  Auto-shutdown after 20 min inactivity\n`)
  const httpServer = serve({ fetch: wrappedFetch as any, port, hostname: '0.0.0.0' })

  // Attach WebSocket for terminal
  attachTerminalWS(httpServer)
}
