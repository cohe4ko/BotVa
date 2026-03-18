import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { formatTs, pagination } from '../views/components.js'
import { getAuditLogs, countAuditLogs, getAuditEventTypes, getBotDir } from '../db-multi.js'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()
const PER_PAGE = 50

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const EVENT_ICONS: Record<string, string> = {
  tool_call: 'wrench',
  command: 'terminal',
  error: 'alert-triangle',
  session_start: 'log-in',
  session_clear: 'trash-2',
}

function eventBadge(type: string) {
  const iconName = EVENT_ICONS[type] ?? 'circle'
  return html`<span class="badge-event badge-event-${type}"><i data-lucide="${iconName}" style="width:11px;height:11px"></i> ${type}</span>`
}

function tailFile(path: string, lines = 100): string {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf-8').split('\n').slice(-lines).join('\n')
}

function findLogFile(botDir: string, botNameStr?: string): string | null {
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

// Combined Logs page: audit events + file log viewer
app.get('/bot/:name/logs', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)

  // Audit section
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const eventType = c.req.query('type') ?? ''
  const search = c.req.query('q') ?? ''
  const total = countAuditLogs(name, eventType || undefined, search || undefined)
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))
  const offset = (page - 1) * PER_PAGE
  const logs = getAuditLogs(name, PER_PAGE, offset, eventType || undefined, search || undefined)
  const eventTypes = getAuditEventTypes(name)
  const baseUrl = `/bot/${name}/logs?${eventType ? `type=${eventType}&` : ''}${search ? `q=${encodeURIComponent(search)}&` : ''}`

  // File log section
  const logFile = findLogFile(getBotDir(name), name)
  const fileLines = Math.min(Math.max(parseInt(c.req.query('lines') || '100', 10), 1), 1000)
  const logContent = logFile ? tailFile(logFile, fileLines) : t('logs.noFile')

  const content = html`
    ${botNav(name, 'logs', t)}

    <!-- Audit events -->
    <div class="section-header">
      <h3>${icon('scroll-text')} ${t('audit.title')}</h3>
      <small>${t('audit.events', { count: total })}</small>
    </div>
    <form method="GET" action="/bot/${name}/logs" class="filter-bar">
      <label>
        <small>${t('audit.type')}</small>
        <select name="type" style="min-width:140px">
          <option value="">${t('audit.allTypes')}</option>
          ${eventTypes.map(tp => html`<option value="${tp}" ${tp === eventType ? 'selected' : ''}>${tp}</option>`)}
        </select>
      </label>
      <label class="filter-search">
        <small>${t('audit.search')}</small>
        <input type="text" name="q" value="${search}" placeholder="${t('audit.searchPlaceholder')}">
      </label>
      <button type="submit" class="btn-sm">${icon('search', 13)} ${t('audit.filter')}</button>
      ${(eventType || search) ? html`<a href="/bot/${name}/logs" role="button" class="btn-sm" style="text-decoration:none">${icon('x', 13)} ${t('audit.clear')}</a>` : ''}
    </form>
    ${logs.length === 0
      ? html`<div class="empty-state"><div class="empty-icon">${icon('scroll-text', 32)}</div><p>${t('audit.noEvents')}</p></div>`
      : html`
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="width:170px">${t('audit.time')}</th>
              <th style="width:140px">${t('audit.type')}</th>
              <th>${t('audit.detail')}</th>
            </tr></thead>
            <tbody>
              ${logs.map(row => html`
                <tr>
                  <td class="ts-cell">${formatTs(row.created_at)}</td>
                  <td>${eventBadge(row.event_type)}</td>
                  <td class="detail-cell">${row.detail ? escapeHtml(row.detail) : '\u2014'}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
        ${pagination(page, totalPages, baseUrl)}
      `
    }

    <!-- Debug context -->
    ${(() => {
      const ctxFile = join(getBotDir(name), 'store', 'debug-context.txt')
      if (!existsSync(ctxFile)) return ''
      const ctxContent = readFileSync(ctxFile, 'utf-8')
      const ctxStat = statSync(ctxFile)
      const ctxTime = new Date(ctxStat.mtimeMs).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
      return html`
        <div class="section-header" style="margin-top:2rem">
          <h3 style="margin:0">${icon('bug')} Agent Context (DEBUG)</h3>
          <small style="font-family:'SF Mono',monospace;font-size:0.72rem">${ctxTime}</small>
        </div>
        <pre class="log-viewer" style="max-height:400px;overflow:auto;white-space:pre-wrap;word-break:break-word">${escapeHtml(ctxContent)}</pre>
      `
    })()}

    <!-- File log -->
    <div class="section-header" style="margin-top:2rem">
      <h3 style="margin:0">${icon('file-text')} ${t('logs.title')}</h3>
      ${logFile ? html`<small style="font-family:'SF Mono',monospace;font-size:0.72rem">${logFile}</small>` : ''}
    </div>
    <div class="btn-group" style="margin-bottom:1rem">
      <a href="/bot/${name}/logs?lines=50" role="button" class="btn-sm ${fileLines === 50 ? 'active' : 'outline'}" style="text-decoration:none">50</a>
      <a href="/bot/${name}/logs?lines=100" role="button" class="btn-sm ${fileLines === 100 ? 'active' : 'outline'}" style="text-decoration:none">100</a>
      <a href="/bot/${name}/logs?lines=500" role="button" class="btn-sm ${fileLines === 500 ? 'active' : 'outline'}" style="text-decoration:none">500</a>
      <span style="font-size:0.72rem;color:var(--mc-text-dim);margin-left:0.25rem">${icon('refresh-cw', 11)} auto-refresh 5s</span>
    </div>
    <div id="log-content" hx-get="/bot/${name}/logs/tail?lines=${fileLines}" hx-trigger="every 5s" hx-swap="innerHTML">
      <pre class="log-viewer">${logContent}</pre>
    </div>
  `
  return c.html(layout(`${name} ${t('logs.title')}`, content, `/bot/${name}/logs`, t, lang))
})

app.get('/bot/:name/logs/tail', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const logFile = findLogFile(getBotDir(name), name)
  const lines = Math.min(Math.max(parseInt(c.req.query('lines') || '100', 10), 1), 1000)
  return c.html(html`<pre class="log-viewer">${logFile ? tailFile(logFile, lines) : t('logs.noFile')}</pre>`)
})

export default app
