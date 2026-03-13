import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav } from '../views/layout.js'
import { getBotDir } from '../db-multi.js'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { validateBot, botName } from '../bot-middleware.js'

const app = new Hono()

function tailFile(path: string, lines = 100): string {
  if (!existsSync(path)) return '(no log file found)'
  return readFileSync(path, 'utf-8').split('\n').slice(-lines).join('\n')
}

function findLogFile(botDir: string, botNameStr?: string): string | null {
  // Check /tmp/botva-<bot>.log first (deploy.sh writes there)
  if (botNameStr) {
    const tmpLog = `/tmp/botva-${botNameStr}.log`
    if (existsSync(tmpLog)) return tmpLog
  }
  for (const c of [join(botDir, 'store', 'bot.log'), join(botDir, 'bot.log'), join(botDir, 'store', 'botva.log')]) {
    if (existsSync(c)) return c
  }
  const storeDir = join(botDir, 'store')
  if (existsSync(storeDir)) {
    const logs = readdirSync(storeDir).filter(f => f.endsWith('.log'))
    if (logs.length > 0) return logs.map(f => ({ p: join(storeDir, f), m: statSync(join(storeDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].p
  }
  return null
}

app.get('/bot/:name/logs', validateBot, (c) => {
  const name = botName(c)
  const logFile = findLogFile(getBotDir(name), name)
  const lines = parseInt(c.req.query('lines') || '100', 10)
  const logContent = logFile ? tailFile(logFile, lines) : '(no log file found)'

  const content = html`
    ${botNav(name, 'logs')}
    <h3>Logs ${logFile ? html`<small>${logFile}</small>` : ''}</h3>
    <div class="btn-group" style="margin-bottom:1rem">
      <a href="/bot/${name}/logs?lines=50" role="button" class="outline">50</a>
      <a href="/bot/${name}/logs?lines=100" role="button" class="outline">100</a>
      <a href="/bot/${name}/logs?lines=500" role="button" class="outline">500</a>
    </div>
    <div id="log-content" hx-get="/bot/${name}/logs/tail?lines=${lines}" hx-trigger="every 5s" hx-swap="innerHTML">
      <pre class="log-viewer">${logContent}</pre>
    </div>
  `
  return c.html(layout(`${name} Logs`, content, `/bot/${name}`))
})

app.get('/bot/:name/logs/tail', validateBot, (c) => {
  const name = botName(c)
  const logFile = findLogFile(getBotDir(name), name)
  const lines = parseInt(c.req.query('lines') || '100', 10)
  return c.html(html`<pre class="log-viewer">${logFile ? tailFile(logFile, lines) : '(no log file found)'}</pre>`)
})

export default app
