import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { authMiddleware, setAuthCookie, loginPage } from './auth.js'
import dashboard from './routes/dashboard.js'
import botConfig from './routes/bot-config.js'
import botKnowledge from './routes/bot-knowledge.js'
import botMemories from './routes/bot-memories.js'
import botTasks from './routes/bot-tasks.js'
import botSessions from './routes/bot-sessions.js'
import botSettings from './routes/bot-settings.js'
import botUsage from './routes/bot-usage.js'
import botImages from './routes/bot-images.js'
import botLogs from './routes/bot-logs.js'
import botAudit from './routes/bot-audit.js'
import system from './routes/system.js'
import createBot from './routes/create-bot.js'
import gallery from './routes/gallery.js'
import storage from './routes/storage.js'
import team from './routes/team.js'

export function createAdminApp(): Hono {
  const app = new Hono()

  // Static files
  app.use('/static/*', serveStatic({ root: 'src/admin/' }))
  app.use('/gallery-img/*', serveStatic({ root: 'workspace/', rewriteRequestPath: (path) => path.replace('/gallery-img/', '/gallery/') }))
  app.use('/gallery-thumb/*', serveStatic({ root: 'workspace/', rewriteRequestPath: (path) => path.replace('/gallery-thumb/', '/gallery/thumbs/') }))

  // Auth
  app.use('*', authMiddleware)

  app.post('/login', async (c) => {
    const body = await c.req.parseBody()
    const token = String(body['token'] ?? '')
    if (setAuthCookie(c, token)) {
      return c.redirect('/')
    }
    return c.html(loginPage('Invalid token'))
  })

  // Routes
  app.route('/', dashboard)
  app.route('/', botConfig)
  app.route('/', botKnowledge)
  app.route('/', botMemories)
  app.route('/', botTasks)
  app.route('/', botSessions)
  app.route('/', botSettings)
  app.route('/', botUsage)
  app.route('/', botImages)
  app.route('/', botLogs)
  app.route('/', botAudit)
  app.route('/', system)
  app.route('/', createBot)
  app.route('/', gallery)
  app.route('/', storage)
  app.route('/', team)

  return app
}

// Standalone mode: npm run admin
const isDirectRun = process.argv[1]?.includes('server')
if (isDirectRun) {
  const app = createAdminApp()
  const port = parseInt(process.env.ADMIN_PORT || '3000', 10)
  console.log(`\n  BotVa Admin Panel\n  http://localhost:${port}\n`)
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })
}
