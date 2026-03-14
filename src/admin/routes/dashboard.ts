import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { statusBadge, formatCost, formatTs } from '../views/components.js'
import { getBotNames, getUsageSummary, getHealthMetrics, getProjectRoot } from '../db-multi.js'
import { getBotStatus, startBot, stopBot, restartBot, getBotUptime, isSelf as isSelfBot } from '../bot-control.js'
import { validateBot, botName } from '../bot-middleware.js'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

app.get('/', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayTs = Math.floor(todayStart.getTime() / 1000)

  const bots = getBotNames().map(name => {
    const status = getBotStatus(name)
    let usage = { requests: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 }
    let health = { lastActivity: null as number | null, avgResponseTimeMs: null as number | null, errorCount24h: 0, requestCount24h: 0 }
    try { usage = getUsageSummary(name, todayTs) } catch {}
    try { health = getHealthMetrics(name) } catch {}
    const uptime = getBotUptime(name)
    return { ...status, usage, health, uptime }
  })

  const totalCost = bots.reduce((s, b) => s + b.usage.costUSD, 0)
  const totalRequests = bots.reduce((s, b) => s + b.usage.requests, 0)
  const runningCount = bots.filter(b => b.running).length

  const content = html`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
      <h2 style="margin:0">${icon('layout-dashboard')} ${t('dash.title')}</h2>
      <a href="/create-bot" style="font-size:0.82rem">${icon('plus', 14)} ${t('dash.createBot')}</a>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('activity', 12)} ${t('dash.botsOnline')}</div>
        <div class="stat-number">${runningCount}<small style="font-size:0.55em;color:var(--mc-text-dim);font-weight:400"> / ${bots.length}</small></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('message-square', 12)} ${t('dash.requestsToday')}</div>
        <div class="stat-number">${totalRequests}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('credit-card', 12)} ${t('dash.costToday')}</div>
        <div class="stat-number">${formatCost(totalCost)}</div>
      </div>
    </div>

    <div id="dash-embedding" hx-get="/embedding/status" hx-trigger="load, every 30s" hx-swap="innerHTML" style="margin-bottom:1rem"></div>

    ${bots.length > 0 ? html`
    <div class="btn-group" style="margin-bottom:1rem" id="bulk-controls">
      <button hx-post="/bots/restart-all" hx-target="#bulk-controls" hx-swap="innerHTML" hx-confirm="${t('dash.confirmRestartAll')}" class="btn-sm contrast outline">${icon('refresh-cw', 12)} ${t('dash.restartAll')}</button>
      <button hx-post="/bots/stop-all" hx-target="#bulk-controls" hx-swap="innerHTML" hx-confirm="${t('dash.confirmStopAll')}" class="btn-sm secondary outline">${icon('square', 12)} ${t('dash.stopAll')}</button>
      <button hx-post="/bots/start-all" hx-target="#bulk-controls" hx-swap="innerHTML" class="btn-sm outline">${icon('play', 12)} ${t('dash.startAll')}</button>
    </div>
    ` : ''}

    <div class="bot-grid">
      ${bots.map(b => html`
        <div class="card">
          <header>
            <span class="badge badge-${b.name}">${b.name}</span>
            ${statusBadge(b.running, t)}
            ${b.pid ? html`<small style="margin-left:auto;color:var(--mc-text-dim)">PID ${b.pid}</small>` : ''}
          </header>
          <div class="card-stats">
            <div class="stat-row">
              <span class="icon">${icon('send', 12)}</span>
              <span>${t('dash.requests')}: <span class="stat-value">${b.usage.requests}</span></span>
              <span style="margin-left:0.5rem">${icon('credit-card', 12)}</span>
              <span>${t('dash.cost')}: <span class="stat-value">${formatCost(b.usage.costUSD)}</span></span>
            </div>
            ${b.uptime ? html`
              <div class="stat-row">
                <span class="icon">${icon('timer', 12)}</span>
                <span>${t('dash.uptime')}: <span class="stat-value">${b.uptime}</span></span>
              </div>
            ` : ''}
            ${b.health.lastActivity ? html`
              <div class="stat-row">
                <span class="icon">${icon('clock', 12)}</span>
                <span>${t('dash.last')}: <span class="stat-value">${formatTs(b.health.lastActivity)}</span></span>
              </div>
            ` : ''}
            ${b.health.avgResponseTimeMs !== null ? html`
              <div class="stat-row">
                <span class="icon">${icon('zap', 12)}</span>
                <span>${t('dash.avgResponse')}: <span class="stat-value">${(b.health.avgResponseTimeMs / 1000).toFixed(1)}s</span></span>
              </div>
            ` : ''}
            ${b.health.errorCount24h > 0 ? html`
              <div class="stat-row">
                <span class="icon">${icon('alert-triangle', 12)}</span>
                <span class="stat-error">${t('dash.errors24h')}: ${b.health.errorCount24h}</span>
              </div>
            ` : ''}
          </div>
          <div class="btn-group" id="controls-${b.name}">
            ${b.running
              ? html`
                <button hx-post="/bot/${b.name}/stop" hx-target="#controls-${b.name}" hx-swap="outerHTML" class="btn-sm secondary outline">${icon('square', 11)} ${t('dash.stop')}</button>
                <button hx-post="/bot/${b.name}/restart" hx-target="#controls-${b.name}" hx-swap="outerHTML" class="btn-sm contrast outline">${icon('refresh-cw', 11)} ${t('dash.restart')}</button>
              `
              : html`
                <button hx-post="/bot/${b.name}/start" hx-target="#controls-${b.name}" hx-swap="outerHTML" class="btn-sm outline">${icon('play', 11)} ${t('dash.start')}</button>
              `
            }
          </div>
          <div class="card-links">
            <a href="/bot/${b.name}/config">${icon('settings', 11)} ${t('dash.config')}</a>
            <a href="/bot/${b.name}/memories">${icon('brain', 11)} ${t('dash.memories')}</a>
            <a href="/bot/${b.name}/usage">${icon('bar-chart-3', 11)} ${t('dash.usage')}</a>
            <a href="/bot/${b.name}/audit">${icon('scroll-text', 11)} ${t('dash.audit')}</a>
            <a href="/bot/${b.name}/logs">${icon('file-text', 11)} ${t('dash.logs')}</a>
          </div>
        </div>
      `)}
    </div>
  `

  return c.html(layout(t('dash.title'), content, '/', t, lang))
})

function refreshResponse(c: import('hono').Context) {
  c.header('HX-Refresh', 'true')
  return c.text('ok')
}

app.post('/bot/:name/start', validateBot, async (c) => {
  startBot(botName(c))
  await new Promise(r => setTimeout(r, 1000))
  return refreshResponse(c)
})

app.post('/bot/:name/stop', validateBot, async (c) => {
  stopBot(botName(c))
  await new Promise(r => setTimeout(r, 500))
  return refreshResponse(c)
})

app.post('/bot/:name/restart', validateBot, async (c) => {
  // restartBot handles self-restart: spawns new process then exits
  await restartBot(botName(c))
  await new Promise(r => setTimeout(r, 1000))
  return refreshResponse(c)
})

app.post('/bots/restart-all', async (c) => {
  const names = getBotNames()
  // Restart others first, self last (self-restart will exit this process)
  const others = names.filter(name => !isSelfBot(name))
  const self = names.filter(name => isSelfBot(name))
  await Promise.all(others.map(name => restartBot(name)))
  if (self.length > 0) {
    // Send response before self-restart kills the process
    c.header('HX-Refresh', 'true')
    const res = c.text('ok')
    // Schedule self-restart after response is sent
    setTimeout(async () => {
      for (const name of self) await restartBot(name)
    }, 100)
    return res
  }
  await new Promise(r => setTimeout(r, 1500))
  return refreshResponse(c)
})

app.post('/bots/stop-all', async (c) => {
  const names = getBotNames()
  // Stop others first, self last
  const others = names.filter(name => !isSelfBot(name))
  const self = names.filter(name => isSelfBot(name))
  others.forEach(name => stopBot(name))
  if (self.length > 0) {
    c.header('HX-Refresh', 'true')
    const res = c.text('ok')
    setTimeout(() => self.forEach(name => stopBot(name)), 100)
    return res
  }
  await new Promise(r => setTimeout(r, 1000))
  return refreshResponse(c)
})

app.post('/bots/start-all', async (c) => {
  getBotNames().forEach(name => { if (!getBotStatus(name).running) startBot(name) })
  await new Promise(r => setTimeout(r, 1500))
  return refreshResponse(c)
})

// Embedding service status fragment (shared between dashboard and system page)
app.get('/embedding/status', async (c) => {
  const t: TFunc = c.get('t')
  const pidPath = resolve(getProjectRoot(), 'store', 'embedding.pid')
  let pid: number | null = null
  if (existsSync(pidPath)) {
    const raw = readFileSync(pidPath, 'utf-8').trim()
    pid = parseInt(raw, 10)
    if (isNaN(pid)) pid = null
  }
  let running = false
  if (pid) { try { process.kill(pid, 0); running = true } catch {} }

  if (!running) {
    return c.html(html`
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">${icon('brain', 12)} ${t('dash.embeddingService')}</div>
          <div class="stat-number" style="font-size:1rem"><span class="badge badge-missing">${icon('x', 11)} ${t('dash.embeddingOffline')}</span></div>
        </div>
      </div>
    `)
  }

  let model = '', uptime = 0, ready = false, requestCount = 0, textsEmbedded = 0
  try {
    const { getHealth } = await import('../../embeddings.js')
    const health = await getHealth()
    if (health) {
      ready = health.ready === true
      model = health.model ?? ''
      uptime = health.uptime ?? 0
      requestCount = health.requestCount ?? 0
      textsEmbedded = health.textsEmbedded ?? 0
    }
  } catch {}

  const uptimeStr = uptime > 3600
    ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
    : uptime > 0
      ? `${Math.floor(uptime / 60)}m`
      : '—'

  return c.html(html`
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('brain', 12)} ${t('dash.embeddingService')}</div>
        <div class="stat-number" style="font-size:1rem">
          ${ready
            ? html`<span class="badge badge-set">${icon('check', 11)} ${t('dash.embeddingOnline')}</span>`
            : html`<span class="badge" style="background:var(--mc-warning);color:#000">${icon('loader', 11)} Loading...</span>`
          }
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('send', 12)} ${t('dash.embeddingRequests')}</div>
        <div class="stat-number">${requestCount}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('file-text', 12)} ${t('dash.embeddingTexts')}</div>
        <div class="stat-number">${textsEmbedded}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('timer', 12)} Uptime</div>
        <div class="stat-number">${uptimeStr}</div>
      </div>
    </div>
  `)
})

export default app
