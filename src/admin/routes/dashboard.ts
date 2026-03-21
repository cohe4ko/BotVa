import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { statusBadge, formatCost, formatTs, guideBlock } from '../views/components.js'
import { getBotNames, getUsageSummary, getHealthMetrics, getProjectRoot, getTasks, getReminders, countFacts, getBotDir } from '../db-multi.js'
import { getBotStatus, startBot, stopBot, restartBot, getBotUptime, isSelf as isSelfBot } from '../bot-control.js'
import { validateBot, botName } from '../bot-middleware.js'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { resolve, join } from 'path'
import { execSync } from 'child_process'
import { getConsolidationHour } from '../../system-settings.js'
import { AGENT_WATCHDOG_WARN_SECONDS, AGENT_WATCHDOG_TIMEOUT_MS } from '../../config.js'
import { readEnv } from '../env-parser.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

function getNodeVersion(): string { return process.versions.node }
function getClaudeVersion(): string {
  try { return execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim() }
  catch { return '(not found)' }
}
function getAdminUptime(): string {
  const secs = process.uptime()
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${h}h ${m}m`
}
function getDiskUsage(dir: string): string {
  try { return execSync(`du -sh "${dir}" 2>/dev/null`, { encoding: 'utf-8' }).split('\t')[0].trim() }
  catch { return '?' }
}

const app = new Hono<I18nEnv>()

app.get('/', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const root = getProjectRoot()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayTs = Math.floor(todayStart.getTime() / 1000)
  const botNames = getBotNames()

  const bots = botNames.map(name => {
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

  // --- Aggregate stats for service panels ---
  let totalTasks = 0, activeTasks = 0, nextTaskRun: number | null = null
  let totalReminders = 0, nextReminderAt: number | null = null
  let totalFacts = 0
  for (const name of botNames) {
    try {
      const tasks = getTasks(name)
      totalTasks += tasks.length
      const active = tasks.filter(t => t.status === 'active')
      activeTasks += active.length
      for (const t of active) {
        if (nextTaskRun === null || t.next_run < nextTaskRun) nextTaskRun = t.next_run
      }
    } catch {}
    try {
      const pending = getReminders(name, 'pending')
      totalReminders += pending.length
      for (const r of pending) {
        if (nextReminderAt === null || r.remind_at < nextReminderAt) nextReminderAt = r.remind_at
      }
    } catch {}
    try { totalFacts += countFacts(name) } catch {}
  }

  // Consolidation info
  const consolidationHour = getConsolidationHour(root)
  let lastConsolidation = ''
  for (const name of botNames) {
    try {
      const diaryDir = join(getBotDir(name), 'knowledge', 'diary')
      if (existsSync(diaryDir)) {
        const files = readdirSync(diaryDir).filter(f => f.endsWith('.md')).sort().reverse()
        if (files.length > 0) {
          const mtime = statSync(join(diaryDir, files[0])).mtimeMs
          const ts = formatTs(Math.floor(mtime / 1000))
          if (!lastConsolidation || ts > lastConsolidation) lastConsolidation = ts
        }
      }
    } catch {}
  }

  // Disk usage
  let diskUsage = '?'
  try { diskUsage = execSync(`du -sh "${root}" 2>/dev/null`, { encoding: 'utf-8' }).split('\t')[0].trim() } catch {}

  // Cost 30 days
  const monthTs = todayTs - 30 * 86400
  let totalMonth = 0
  for (const name of botNames) {
    try { totalMonth += getUsageSummary(name, monthTs).costUSD } catch {}
  }

  // API Keys overview
  const botApiKeys = botNames.map(name => {
    const env = readEnv(name)
    return {
      name,
      hasToken: !!env['TELEGRAM_BOT_TOKEN'],
      hasGroq: !!env['GROQ_API_KEY'],
      hasGoogle: !!env['GOOGLE_API_KEY'],
      hasChatId: !!env['ALLOWED_CHAT_ID'],
    }
  })

  const content = html`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:0.5rem">
      <h2 style="margin:0">${icon('layout-dashboard')} ${t('dash.title')}</h2>
      <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
        ${bots.length > 0 ? html`
          <div class="btn-group" id="bulk-controls">
            <button hx-post="/bots/start-all" hx-target="#bulk-controls" hx-swap="innerHTML" class="btn-sm outline">${icon('play', 11)} ${t('dash.startAll')}</button>
            <button hx-post="/bots/stop-all" hx-target="#bulk-controls" hx-swap="innerHTML" hx-confirm="${t('dash.confirmStopAll')}" class="btn-sm secondary outline">${icon('square', 11)} ${t('dash.stopAll')}</button>
            <button hx-post="/bots/restart-all" hx-target="#bulk-controls" hx-swap="innerHTML" hx-confirm="${t('dash.confirmRestartAll')}" class="btn-sm contrast outline">${icon('refresh-cw', 11)} ${t('dash.restartAll')}</button>
          </div>
        ` : ''}
        <a href="/create-bot" class="btn-sm" style="text-decoration:none">${icon('plus', 12)} ${t('dash.createBot')}</a>
      </div>
    </div>

    <div class="stats-grid" style="margin-bottom:1rem">
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
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} ${t('sys.cost30')}</div>
        <div class="stat-number">${formatCost(totalMonth)}</div>
      </div>
    </div>

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
            <a href="/bot/${b.name}/facts">${icon('database', 11)} ${t('dash.facts')}</a>
            <a href="/bot/${b.name}/tasks">${icon('calendar', 11)} ${t('dash.tasks')}</a>
            <a href="/bot/${b.name}/logs">${icon('file-text', 11)} ${t('dash.logs')}</a>
          </div>
        </div>
      `)}
    </div>

    <h3 style="margin-top:1.5rem;margin-bottom:0.75rem">${icon('server')} ${t('dash.services')}</h3>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} ${t('dash.scheduler')}</div>
        <div class="stat-number">${activeTasks}<small style="font-size:0.55em;color:var(--mc-text-dim);font-weight:400"> / ${totalTasks}</small></div>
        <div style="font-size:0.68rem;color:var(--mc-text-dim);margin-top:0.2rem">
          ${nextTaskRun ? html`${t('dash.nextRun')}: ${formatTs(nextTaskRun)}` : t('dash.noTasks')}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('bell', 12)} ${t('dash.reminders')}</div>
        <div class="stat-number">${totalReminders}</div>
        <div style="font-size:0.68rem;color:var(--mc-text-dim);margin-top:0.2rem">
          ${nextReminderAt ? html`${t('dash.nextReminder')}: ${formatTs(nextReminderAt)}` : t('dash.noReminders')}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('database', 12)} ${t('dash.facts')}</div>
        <div class="stat-number">${totalFacts}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('refresh-cw', 12)} ${t('dash.consolidation')}</div>
        <div class="stat-number" style="font-size:1rem">${String(consolidationHour).padStart(2, '0')}:00</div>
        <div style="font-size:0.68rem;color:var(--mc-text-dim);margin-top:0.2rem">
          ${lastConsolidation ? html`${t('dash.lastRun')}: ${lastConsolidation}` : t('dash.neverRun')}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('hard-drive', 12)} ${t('dash.disk')}</div>
        <div class="stat-number" style="font-size:1.1rem">${diskUsage}</div>
      </div>
    </div>

    <h3 style="margin-top:1rem;margin-bottom:0.75rem">${icon('brain')} ${t('dash.embeddingService')}</h3>
    <div id="dash-embedding" hx-get="/embedding/status" hx-trigger="load, every 30s" hx-swap="innerHTML"></div>

    <h3 style="margin-top:1.5rem;margin-bottom:0.75rem">${icon('monitor')} ${t('sys.platform')}</h3>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('hexagon', 12)} ${t('sys.nodejs')}</div>
        <div class="stat-number" style="font-size:1.1rem">${getNodeVersion()}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('bot', 12)} ${t('sys.claudeCli')}</div>
        <div class="stat-number" style="font-size:1.1rem">${getClaudeVersion()}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('timer', 12)} ${t('sys.adminUptime')}</div>
        <div class="stat-number">${getAdminUptime()}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('monitor', 12)} OS</div>
        <div class="stat-number" style="font-size:1.1rem">${process.platform} ${process.arch}</div>
      </div>
    </div>

    <h3 style="margin-top:1rem;margin-bottom:0.75rem">${icon('hard-drive')} ${t('sys.storage')}</h3>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${t('sys.projectTotal')}</div>
        <div class="stat-number">${diskUsage}</div>
      </div>
      ${botNames.map(name => html`
        <div class="stat-card">
          <div class="stat-label">${name}</div>
          <div class="stat-number">${getDiskUsage(getBotDir(name))}</div>
        </div>
      `)}
    </div>

    <h3 style="margin-top:1rem;margin-bottom:0.75rem">${icon('key')} ${t('sys.apiKeys')}</h3>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>${t('sys.bot')}</th>
            <th>${t('sys.telegram')}</th>
            <th>${t('sys.chatId')}</th>
            <th class="hide-mobile">${t('sys.groq')}</th>
            <th class="hide-mobile">${t('sys.google')}</th>
          </tr>
        </thead>
        <tbody>
          ${botApiKeys.map(b => html`
            <tr>
              <td><span class="badge badge-${b.name}">${b.name}</span></td>
              <td>${b.hasToken ? html`<span class="badge badge-set">${icon('check', 11)} ${t('sys.set')}</span>` : html`<span class="badge badge-missing">${icon('x', 11)} ${t('sys.missing')}</span>`}</td>
              <td>${b.hasChatId ? html`<span class="badge badge-set">${icon('check', 11)} ${t('sys.set')}</span>` : html`<span class="badge badge-missing">${icon('x', 11)} ${t('sys.missing')}</span>`}</td>
              <td class="hide-mobile">${b.hasGroq ? html`<span class="badge badge-set">${icon('check', 11)} ${t('sys.set')}</span>` : html`<span class="badge badge-optional">${t('sys.optional')}</span>`}</td>
              <td class="hide-mobile">${b.hasGoogle ? html`<span class="badge badge-set">${icon('check', 11)} ${t('sys.set')}</span>` : html`<span class="badge badge-optional">${t('sys.optional')}</span>`}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>

    <h3 style="margin-top:1rem;margin-bottom:0.75rem">${icon('message-square')} ${t('sys.telegramCommands')}</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>${t('sys.tgCommand')}</th><th>${t('sys.tgDescription')}</th></tr></thead>
        <tbody>
          ${[
            ['/start', t('sys.tgStart')],
            ['/chatid', t('sys.tgChatid')],
            ['/newchat', t('sys.tgNewchat')],
            ['/model', t('sys.tgModel')],
            ['/memory', t('sys.tgMemory')],
            ['/voice', t('sys.tgVoice')],
            ['/usage', t('sys.tgUsage')],
            ['/stats', t('sys.tgStats')],
            ['/img <prompt>', t('sys.tgImg')],
            ['/cancel', t('sys.tgCancel')],
          ].map(([cmd, desc]) => html`<tr><td><code>${cmd}</code></td><td>${desc}</td></tr>`)}
        </tbody>
      </table>
    </div>

    <h3 style="margin-top:1rem;margin-bottom:0.75rem">${icon('layers')} ${t('sys.architecture')}</h3>
    <div class="table-wrap">
      <table>
        <tbody>
          <tr><td style="width:120px"><strong>${t('sys.agent')}</strong></td><td>${t('sys.agentDesc')}</td></tr>
          <tr><td><strong>Telegram</strong></td><td>${t('sys.telegramDesc')}</td></tr>
          <tr><td><strong>${t('sys.database')}</strong></td><td>${t('sys.databaseDesc')}</td></tr>
          <tr><td><strong>${t('sys.memory')}</strong></td><td>${t('sys.memoryDesc')}</td></tr>
          <tr><td><strong>${t('sys.consolidation')}</strong></td><td>${t('sys.consolidationDesc')}</td></tr>
          <tr><td><strong>${t('sys.scheduler')}</strong></td><td>${t('sys.schedulerDesc')}</td></tr>
          <tr><td><strong>${t('sys.watchdog')}</strong></td><td>Warn ${AGENT_WATCHDOG_WARN_SECONDS}s / timeout ${Math.round(AGENT_WATCHDOG_TIMEOUT_MS / 1000)}s</td></tr>
        </tbody>
      </table>
    </div>

    ${guideBlock(t('guide.dashboard.title'), [t('guide.dashboard.1'), t('guide.dashboard.2'), t('guide.dashboard.3'), t('guide.dashboard.4')])}
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
          <div class="stat-label">${t('dash.embeddingStatus')}</div>
          <div class="stat-number" style="font-size:1rem"><span class="badge badge-missing">${icon('x', 11)} ${t('dash.embeddingOffline')}</span></div>
        </div>
      </div>
    `)
  }

  let uptime = 0, ready = false, requestCount = 0, textsEmbedded = 0
  try {
    const { getHealth } = await import('../../embeddings.js')
    const health = await getHealth()
    if (health) {
      ready = health.ready === true
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
        <div class="stat-label">${t('dash.embeddingStatus')}</div>
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
