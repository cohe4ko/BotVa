import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { statusBadge, formatCost, formatTs } from '../views/components.js'
import { getBotNames, getUsageSummary, getHealthMetrics } from '../db-multi.js'
import { getBotStatus, startBot, stopBot, restartBot, getBotUptime, isSelf as isSelfBot } from '../bot-control.js'
import { validateBot, botName } from '../bot-middleware.js'

const app = new Hono()

app.get('/', (c) => {
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
      <h2 style="margin:0">${icon('layout-dashboard')} Dashboard</h2>
      <a href="/create-bot" style="font-size:0.82rem">${icon('plus', 14)} Create bot</a>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('activity', 12)} Bots online</div>
        <div class="stat-number">${runningCount}<small style="font-size:0.55em;color:var(--mc-text-dim);font-weight:400"> / ${bots.length}</small></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('message-square', 12)} Requests today</div>
        <div class="stat-number">${totalRequests}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('credit-card', 12)} Cost today</div>
        <div class="stat-number">${formatCost(totalCost)}</div>
      </div>
    </div>

    <div class="btn-group" style="margin-bottom:1rem" id="bulk-controls">
      <button hx-post="/bots/restart-all" hx-target="#bulk-controls" hx-swap="innerHTML" hx-confirm="Restart all bots?" class="btn-sm contrast outline">${icon('refresh-cw', 12)} Restart All</button>
      <button hx-post="/bots/stop-all" hx-target="#bulk-controls" hx-swap="innerHTML" hx-confirm="Stop all bots?" class="btn-sm secondary outline">${icon('square', 12)} Stop All</button>
      <button hx-post="/bots/start-all" hx-target="#bulk-controls" hx-swap="innerHTML" class="btn-sm outline">${icon('play', 12)} Start All</button>
    </div>

    <div class="bot-grid">
      ${bots.map(b => html`
        <div class="card">
          <header>
            <span class="badge badge-${b.name}">${b.name}</span>
            ${statusBadge(b.running)}
            ${b.pid ? html`<small style="margin-left:auto;color:var(--mc-text-dim)">PID ${b.pid}</small>` : ''}
          </header>
          <div class="card-stats">
            <div class="stat-row">
              <span class="icon">${icon('send', 12)}</span>
              <span>Requests: <span class="stat-value">${b.usage.requests}</span></span>
              <span style="margin-left:0.5rem">${icon('credit-card', 12)}</span>
              <span>Cost: <span class="stat-value">${formatCost(b.usage.costUSD)}</span></span>
            </div>
            ${b.uptime ? html`
              <div class="stat-row">
                <span class="icon">${icon('timer', 12)}</span>
                <span>Uptime: <span class="stat-value">${b.uptime}</span></span>
              </div>
            ` : ''}
            ${b.health.lastActivity ? html`
              <div class="stat-row">
                <span class="icon">${icon('clock', 12)}</span>
                <span>Last: <span class="stat-value">${formatTs(b.health.lastActivity)}</span></span>
              </div>
            ` : ''}
            ${b.health.avgResponseTimeMs !== null ? html`
              <div class="stat-row">
                <span class="icon">${icon('zap', 12)}</span>
                <span>Avg response: <span class="stat-value">${(b.health.avgResponseTimeMs / 1000).toFixed(1)}s</span></span>
              </div>
            ` : ''}
            ${b.health.errorCount24h > 0 ? html`
              <div class="stat-row">
                <span class="icon">${icon('alert-triangle', 12)}</span>
                <span class="stat-error">Errors 24h: ${b.health.errorCount24h}</span>
              </div>
            ` : ''}
          </div>
          <div class="btn-group" id="controls-${b.name}">
            ${b.running
              ? html`
                <button hx-post="/bot/${b.name}/stop" hx-target="#controls-${b.name}" hx-swap="outerHTML" class="btn-sm secondary outline">${icon('square', 11)} Stop</button>
                <button hx-post="/bot/${b.name}/restart" hx-target="#controls-${b.name}" hx-swap="outerHTML" class="btn-sm contrast outline">${icon('refresh-cw', 11)} Restart</button>
              `
              : html`
                <button hx-post="/bot/${b.name}/start" hx-target="#controls-${b.name}" hx-swap="outerHTML" class="btn-sm outline">${icon('play', 11)} Start</button>
              `
            }
          </div>
          <div class="card-links">
            <a href="/bot/${b.name}/config">${icon('settings', 11)} Config</a>
            <a href="/bot/${b.name}/memories">${icon('brain', 11)} Memories</a>
            <a href="/bot/${b.name}/usage">${icon('bar-chart-3', 11)} Usage</a>
            <a href="/bot/${b.name}/audit">${icon('scroll-text', 11)} Audit</a>
            <a href="/bot/${b.name}/logs">${icon('file-text', 11)} Logs</a>
          </div>
        </div>
      `)}
    </div>
  `

  return c.html(layout('Dashboard', content, '/'))
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

export default app
