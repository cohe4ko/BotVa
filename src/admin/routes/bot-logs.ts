import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav } from '../views/layout.js'
import { getBotDir } from '../db-multi.js'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

function tailFile(path: string, lines = 100): string {
  if (!existsSync(path)) return ''
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
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const logFile = findLogFile(getBotDir(name), name)
  const lines = Math.min(Math.max(parseInt(c.req.query('lines') || '100', 10), 1), 1000)
  const logContent = logFile ? tailFile(logFile, lines) : t('logs.noFile')

  const content = html`
    ${botNav(name, 'logs', t)}
    <div class="section-header">
      <h3 style="margin:0"><i data-lucide="file-text" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('logs.title')}</h3>
      ${logFile ? html`<small style="font-family:'SF Mono',monospace;font-size:0.72rem">${logFile}</small>` : ''}
    </div>
    <div class="btn-group" style="margin-bottom:1rem">
      <a href="/bot/${name}/logs?lines=50" role="button" class="btn-sm ${lines === 50 ? 'active' : 'outline'}" style="text-decoration:none">50</a>
      <a href="/bot/${name}/logs?lines=100" role="button" class="btn-sm ${lines === 100 ? 'active' : 'outline'}" style="text-decoration:none">100</a>
      <a href="/bot/${name}/logs?lines=500" role="button" class="btn-sm ${lines === 500 ? 'active' : 'outline'}" style="text-decoration:none">500</a>
      <span style="font-size:0.72rem;color:var(--mc-text-dim);margin-left:0.25rem"><i data-lucide="refresh-cw" style="width:11px;height:11px;display:inline-block;vertical-align:middle"></i> auto-refresh 5s</span>
    </div>
    <div id="log-content" hx-get="/bot/${name}/logs/tail?lines=${lines}" hx-trigger="every 5s" hx-swap="innerHTML">
      <pre class="log-viewer">${logContent}</pre>
    </div>
  `
  return c.html(layout(`${name} ${t('logs.title')}`, content, `/bot/${name}`, t, lang))
})

app.get('/bot/:name/logs/tail', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const logFile = findLogFile(getBotDir(name), name)
  const lines = Math.min(Math.max(parseInt(c.req.query('lines') || '100', 10), 1), 1000)
  return c.html(html`<pre class="log-viewer">${logFile ? tailFile(logFile, lines) : t('logs.noFile')}</pre>`)
})

export default app
