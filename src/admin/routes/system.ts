import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { formatCost } from '../views/components.js'
import { getBotNames, getUsageSummary, getBotDir, getProjectRoot, getToolUsageStats, type ToolUsageStat } from '../db-multi.js'
import { readEnv } from '../env-parser.js'
import { getMcpServersConfig, isServerDisabled, setServerEnabled, addMcpServer, removeMcpServer, getMcpServer, updateMcpServer, type McpServerEntry } from '../../mcp-config.js'
import { getBuiltinToolDefs, setToolEnabled, type BuiltinToolDef } from '../../builtin-tools.js'
import { existsSync, readdirSync, renameSync, readFileSync, openSync } from 'fs'
import { resolve, join } from 'path'
import { execSync, spawn } from 'child_process'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import { getConsolidationHour, setSystemSetting } from '../../system-settings.js'

const app = new Hono<I18nEnv>()

function getNodeVersion(): string { return process.versions.node }
function getClaudeVersion(): string {
  try { return execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim() }
  catch { return '(not found)' }
}
function getUptime(): string {
  const secs = process.uptime()
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${h}h ${m}m`
}
function getDiskUsage(dir: string): string {
  try { return execSync(`du -sh "${dir}" 2>/dev/null`, { encoding: 'utf-8' }).split('\t')[0].trim() }
  catch { return '?' }
}

interface SkillInfo {
  name: string
  enabled: boolean
  description: string
  tokens: number
}

// Rough token estimate: ~4 chars per token for English/markdown
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function getSkillsDir(): string {
  return resolve(getProjectRoot(), '.claude', 'skills')
}

function getProjectSkills(): SkillInfo[] {
  const skillsDir = getSkillsDir()
  if (!existsSync(skillsDir)) return []
  try {
    const dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()

    return dirs.map(name => {
      const enabledPath = join(skillsDir, name, 'SKILL.md')
      const disabledPath = join(skillsDir, name, 'SKILL.md.off')
      const enabled = existsSync(enabledPath)
      const filePath = enabled ? enabledPath : disabledPath
      let description = ''
      let tokens = 0
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, 'utf-8')
        tokens = estimateTokens(content)
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
            description = trimmed.slice(0, 100)
            break
          }
        }
      }
      // Also count supporting files in the skill directory
      try {
        const allFiles = readdirSync(join(skillsDir, name), { recursive: true })
          .map(f => String(f))
          .filter(f => f !== 'SKILL.md' && f !== 'SKILL.md.off' && (f.endsWith('.md') || f.endsWith('.css') || f.endsWith('.html')))
        for (const f of allFiles) {
          try { tokens += estimateTokens(readFileSync(join(skillsDir, name, f), 'utf-8')) } catch {}
        }
      } catch {}
      return { name, enabled, description, tokens }
    }).filter(s => existsSync(join(skillsDir, s.name, 'SKILL.md')) || existsSync(join(skillsDir, s.name, 'SKILL.md.off')))
  } catch { return [] }
}

// --- Embedding service helpers ---

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf-8').trim()
  const pid = parseInt(raw, 10)
  return isNaN(pid) ? null : pid
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function getEmbeddingPidPath(): string {
  return resolve(getProjectRoot(), 'store', 'embedding.pid')
}

app.get('/system', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const root = getProjectRoot()
  const botNames = getBotNames()

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayTs = Math.floor(todayStart.getTime() / 1000)
  const monthTs = todayTs - 30 * 86400

  let totalToday = 0, totalMonth = 0
  for (const name of botNames) {
    try { totalToday += getUsageSummary(name, todayTs).costUSD; totalMonth += getUsageSummary(name, monthTs).costUSD } catch {}
  }

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

  // Merge env from all bots to determine which MCP servers are available
  const mergedEnv: Record<string, string> = {}
  for (const name of botNames) {
    const bEnv = readEnv(name)
    for (const [k, v] of Object.entries(bEnv)) {
      if (v && !mergedEnv[k]) mergedEnv[k] = v
    }
  }
  const mcpServers = getMcpServersConfig(mergedEnv)

  const projectSkills = getProjectSkills()

  const content = html`
    <h2>${icon('server')} ${t('sys.title')}</h2>

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
        <div class="stat-number">${getUptime()}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('monitor', 12)} ${t('sys.platform')}</div>
        <div class="stat-number" style="font-size:1.1rem">${process.platform} ${process.arch}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('credit-card', 12)} ${t('sys.costToday')}</div>
        <div class="stat-number">${formatCost(totalToday)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('calendar', 12)} ${t('sys.cost30')}</div>
        <div class="stat-number">${formatCost(totalMonth)}</div>
      </div>
    </div>

    <h3>${icon('brain')} ${t('sys.embeddingService')}</h3>
    <div id="embedding-status" hx-get="/system/embedding/status" hx-trigger="load, every 30s" hx-swap="innerHTML">
      <span style="color:var(--mc-text-dim)">Loading...</span>
    </div>

    <h3>${icon('hard-drive')} ${t('sys.storage')}</h3>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${t('sys.projectTotal')}</div>
        <div class="stat-number">${getDiskUsage(root)}</div>
      </div>
      ${botNames.map(name => html`
        <div class="stat-card">
          <div class="stat-label">${name}</div>
          <div class="stat-number">${getDiskUsage(getBotDir(name))}</div>
        </div>
      `)}
    </div>

    <h3>${icon('key')} ${t('sys.apiKeys')}</h3>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>${t('sys.bot')}</th>
            <th>${t('sys.telegram')}</th>
            <th>${t('sys.chatId')}</th>
            <th>${t('sys.groq')}</th>
            <th>${t('sys.google')}</th>
          </tr>
        </thead>
        <tbody>
          ${botApiKeys.map(b => html`
            <tr>
              <td><span class="badge badge-${b.name}">${b.name}</span></td>
              <td>${b.hasToken ? html`<span class="badge badge-set">${icon('check', 11)} ${t('sys.set')}</span>` : html`<span class="badge badge-missing">${icon('x', 11)} ${t('sys.missing')}</span>`}</td>
              <td>${b.hasChatId ? html`<span class="badge badge-set">${icon('check', 11)} ${t('sys.set')}</span>` : html`<span class="badge badge-missing">${icon('x', 11)} ${t('sys.missing')}</span>`}</td>
              <td>${b.hasGroq ? html`<span class="badge badge-set">${icon('check', 11)} ${t('sys.set')}</span>` : html`<span class="badge badge-optional">${t('sys.optional')}</span>`}</td>
              <td>${b.hasGoogle ? html`<span class="badge badge-set">${icon('check', 11)} ${t('sys.set')}</span>` : html`<span class="badge badge-optional">${t('sys.optional')}</span>`}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>

    <h3>${icon('plug')} ${t('sys.mcpServers')}</h3>
    ${renderMcpTable(mcpServers, getEnvBotMap(), t)}

    <h3>${icon('wrench')} ${t('sys.agentTools')}</h3>
    ${renderBuiltinToolsTable(getBuiltinToolDefs(mergedEnv), t, getToolUsageStats())}

    <h3>${icon('puzzle')} ${t('sys.skills')}</h3>
    ${renderSkillsTable(projectSkills, t)}

    <h3>${icon('message-square')} ${t('sys.telegramCommands')}</h3>
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

    <h3>${icon('settings')} ${t('sys.settings')}</h3>
    <div class="form-section" id="sys-settings">
      <form hx-post="/system/settings" hx-target="#sys-settings-alert" hx-swap="innerHTML" style="max-width:400px">
        <div id="sys-settings-alert"></div>
        <label>${t('sys.consolidationHour')}
          <select name="consolidationHour">
            ${[0, 2, 4].map(h => html`<option value="${h}" ${h === getConsolidationHour(root) ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`)}
          </select>
          <small>${t('sys.consolidationHourHint')}</small>
        </label>
        <button type="submit" style="margin-top:0.5rem">${icon('save', 13)} ${t('sys.save')}</button>
      </form>
    </div>

    <h3>${icon('layers')} ${t('sys.architecture')}</h3>
    <div class="table-wrap">
      <table>
        <tbody>
          <tr><td style="width:120px"><strong>${t('sys.agent')}</strong></td><td>${t('sys.agentDesc')}</td></tr>
          <tr><td><strong>Telegram</strong></td><td>${t('sys.telegramDesc')}</td></tr>
          <tr><td><strong>${t('sys.database')}</strong></td><td>${t('sys.databaseDesc')}</td></tr>
          <tr><td><strong>${t('sys.memory')}</strong></td><td>${t('sys.memoryDesc')}</td></tr>
          <tr><td><strong>${t('sys.consolidation')}</strong></td><td>${t('sys.consolidationDesc')}</td></tr>
          <tr><td><strong>${t('sys.scheduler')}</strong></td><td>${t('sys.schedulerDesc')}</td></tr>
          <tr><td><strong>${t('sys.watchdog')}</strong></td><td>Warn ${process.env.AGENT_WATCHDOG_WARN_SECONDS || '60'}s / timeout ${process.env.AGENT_WATCHDOG_TIMEOUT_MS || '600000'}ms</td></tr>
        </tbody>
      </table>
    </div>
  `

  return c.html(layout(t('sys.title'), content, '/system', t, lang))
})

// Toggle skill on/off by renaming SKILL.md <-> SKILL.md.off
function renderSkillsTable(skills: SkillInfo[], t: TFunc) {
  return html`
    <div class="table-wrap" id="skills-table">
      <table>
        <thead><tr><th>${t('sys.skill')}</th><th>${t('sys.skillDesc')}</th><th style="width:70px">${t('sys.skillTokens')}</th><th style="width:80px">${t('sys.skillStatus')}</th><th style="width:50px"></th></tr></thead>
        <tbody>
          ${skills.map(s => html`
            <tr>
              <td><code>/${s.name}</code></td>
              <td style="font-size:0.78rem;color:var(--mc-text-secondary)">${s.description}</td>
              <td style="font-size:0.78rem;color:var(--mc-text-dim);font-variant-numeric:tabular-nums">${formatTokens(s.tokens)}</td>
              <td>
                <button
                  hx-post="/system/skill-toggle/${s.name}"
                  hx-target="#skills-table"
                  hx-swap="outerHTML"
                  class="btn-sm ${s.enabled ? '' : 'secondary outline'}"
                  style="min-width:60px;${s.enabled ? 'background:var(--mc-green);color:#fff;border-color:var(--mc-green)' : ''}"
                >${s.enabled ? html`${icon('check', 11)} ${t('sys.skillOn')}` : html`${icon('x', 11)} ${t('sys.skillOff')}`}</button>
              </td>
              <td>
                <a href="/system/skill-edit/${s.name}" class="btn-sm outline" style="text-decoration:none">${icon('pencil', 11)}</a>
              </td>
            </tr>
          `)}
          ${skills.length === 0 ? html`<tr><td colspan="5" style="text-align:center;color:var(--mc-text-dim)">${t('sys.noSkills')}</td></tr>` : ''}
        </tbody>
      </table>
    </div>
  `
}

/** For each env var, returns list of bot names that have it */
function getEnvBotMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const botName of getBotNames()) {
    const bEnv = readEnv(botName)
    for (const [k, v] of Object.entries(bEnv)) {
      if (v) {
        if (!map[k]) map[k] = []
        map[k].push(botName)
      }
    }
  }
  return map
}

function getMergedEnv(): Record<string, string> {
  const mergedEnv: Record<string, string> = {}
  for (const botName of getBotNames()) {
    const bEnv = readEnv(botName)
    for (const [k, v] of Object.entries(bEnv)) {
      if (v && !mergedEnv[k]) mergedEnv[k] = v
    }
  }
  return mergedEnv
}

function renderMcpTable(servers: McpServerEntry[], envBotMap: Record<string, string[]>, t: TFunc) {
  return html`
    <div class="table-wrap" id="mcp-table">
      <table>
        <thead><tr><th>${t('sys.server')}</th><th>${t('sys.command')}</th><th>${t('sys.env')}</th><th style="width:80px">${t('sys.mcpStatus')}</th><th style="width:80px"></th></tr></thead>
        <tbody>
          ${servers.map(s => {
            const active = s.enabled && s.userEnabled
            const envVars = s.condition === 'always' ? [] : s.condition.split(' + ')
            return html`
              <tr${!s.userEnabled ? ' style="opacity:0.55"' : ''}>
                <td><strong>${s.name}</strong></td>
                <td><code style="font-size:0.72rem">${s.command} ${s.args.join(' ').replace(new RegExp(getProjectRoot().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.').slice(0, 80)}${s.args.join(' ').length > 80 ? '…' : ''}</code></td>
                <td>${s.condition === 'always'
                  ? html`<span class="badge badge-set" style="font-size:0.7rem">${icon('check', 11)} always</span>`
                  : envVars.map(v => {
                      const bots = envBotMap[v] ?? []
                      return html`
                        <div style="margin-bottom:0.25rem">
                          <code style="font-size:0.68rem;color:var(--mc-text-dim)">${v}</code>
                          ${bots.length > 0
                            ? bots.map(b => html`<span class="badge badge-${b}" style="font-size:0.6rem;padding:0.05rem 0.3rem;margin-left:0.2rem">${b}</span>`)
                            : html`<span class="badge badge-missing" style="font-size:0.6rem;padding:0.05rem 0.3rem;margin-left:0.2rem">${icon('x', 9)} ${t('sys.missing')}</span>`
                          }
                        </div>
                      `
                    })
                }</td>
                <td>
                  <button
                    hx-post="/system/mcp-toggle/${s.name}"
                    hx-target="#mcp-table"
                    hx-swap="outerHTML"
                    class="btn-sm ${active ? '' : 'secondary outline'}"
                    style="min-width:60px;${active ? 'background:var(--mc-green);color:#fff;border-color:var(--mc-green)' : ''}"
                  >${s.userEnabled ? html`${icon('check', 11)} ${t('sys.skillOn')}` : html`${icon('x', 11)} ${t('sys.skillOff')}`}</button>
                </td>
                <td>
                  <div style="display:flex;gap:0.25rem;flex-wrap:nowrap">
                    <a href="/system/mcp-edit/${s.name}" class="btn-sm outline" style="text-decoration:none;white-space:nowrap">${icon('pencil', 11)}</a>
                    <button hx-delete="/system/mcp-delete/${s.name}" hx-target="#mcp-table" hx-swap="outerHTML" hx-confirm="${t('sys.deleteConfirm', { name: s.name })}" class="btn-sm secondary outline" style="white-space:nowrap">${icon('trash-2', 11)}</button>
                  </div>
                </td>
              </tr>
            `
          })}
          ${servers.length === 0 ? html`<tr><td colspan="5" style="text-align:center;color:var(--mc-text-dim)">${t('sys.noMcp')}</td></tr>` : ''}
        </tbody>
      </table>
      <div style="padding:0.5rem 0.75rem;border-top:1px solid var(--mc-border)">
        <a href="/system/mcp-add" class="btn-sm outline" style="text-decoration:none">${icon('plus', 11)} ${t('sys.addMcp')}</a>
      </div>
    </div>
  `
}

// --- Builtin tools table ---

const CATEGORY_LABELS: Record<string, { en: string; uk: string }> = {
  standard: { en: 'Standard (Claude)', uk: 'Стандартні (Claude)' },
  image: { en: 'Image', uk: 'Зображення' },
  voice: { en: 'Voice', uk: 'Голос' },
  publish: { en: 'Publishing', uk: 'Публікація' },
  gallery: { en: 'Gallery', uk: 'Галерея' },
  backup: { en: 'Backup', uk: 'Бекап' },
  telegram: { en: 'Telegram', uk: 'Telegram' },
}

function renderBuiltinToolsTable(tools: BuiltinToolDef[], t: TFunc, stats: Record<string, ToolUsageStat> = {}) {
  // Group by category
  const categories = [...new Set(tools.map(t => t.category))]

  const fmtStat = (s?: ToolUsageStat) => {
    if (!s || s.total === 0) return html`<span style="color:var(--mc-text-dim)">—</span>`
    return html`<span style="font-size:0.68rem;color:var(--mc-text-secondary);white-space:nowrap">7д: <b>${s.last7d}</b> · 30д: <b>${s.last30d}</b> · ∑ <b>${s.total}</b></span>`
  }

  return html`
    <div class="table-wrap" id="builtin-tools-table">
      <table>
        <thead><tr>
          <th style="width:40px"></th>
          <th>${t('sys.tool')}</th>
          <th>${t('sys.toolDesc')}</th>
          <th style="width:180px">${t('sys.tool') === 'Tool' ? 'Usage' : 'Використання'}</th>
          <th style="width:120px">${t('sys.toolCondition')}</th>
          <th style="width:80px">${t('sys.skillStatus')}</th>
        </tr></thead>
        <tbody>
          ${categories.map(cat => {
            const catTools = tools.filter(t => t.category === cat)
            const lang = t('sys.tool') === 'Tool' ? 'en' : 'uk'
            const catLabel = CATEGORY_LABELS[cat]?.[lang] ?? cat
            return html`
              <tr><td colspan="6" style="background:var(--mc-bg-alt);font-weight:600;font-size:0.78rem;padding:0.4rem 0.75rem;color:var(--mc-text-secondary)">${catLabel}</td></tr>
              ${catTools.map(tool => html`
                <tr${!tool.available ? ' style="opacity:0.45"' : ''}>
                  <td style="text-align:center;color:var(--mc-text-dim)">${icon(tool.icon, 15)}</td>
                  <td><code style="font-size:0.78rem">${tool.name}</code></td>
                  <td style="font-size:0.78rem;color:var(--mc-text-secondary)">${tool.description}</td>
                  <td>${fmtStat(stats[tool.name])}</td>
                  <td style="font-size:0.72rem">${tool.condition
                    ? (tool.available
                      ? html`<span class="badge badge-set" style="font-size:0.65rem">${icon('check', 9)} ${tool.condition}</span>`
                      : html`<span class="badge badge-missing" style="font-size:0.65rem">${icon('x', 9)} ${tool.condition}</span>`)
                    : html`<span style="color:var(--mc-text-dim);font-size:0.7rem">—</span>`
                  }</td>
                  <td>${tool.system
                    ? html`<span class="badge badge-set" style="font-size:0.65rem">${icon('check', 9)} system</span>`
                    : html`<button
                      hx-post="/system/tool-toggle/${tool.name}"
                      hx-target="#builtin-tools-table"
                      hx-swap="outerHTML"
                      class="btn-sm ${tool.enabled && tool.available ? '' : 'secondary outline'}"
                      style="min-width:60px;${tool.enabled && tool.available ? 'background:var(--mc-green);color:#fff;border-color:var(--mc-green)' : ''}"
                      ${!tool.available ? 'disabled' : ''}
                    >${tool.enabled ? html`${icon('check', 11)} ${t('sys.skillOn')}` : html`${icon('x', 11)} ${t('sys.skillOff')}`}</button>`
                  }</td>
                </tr>
              `)}
            `
          })}
        </tbody>
      </table>
    </div>
  `
}

// --- Embedding service routes ---

app.get('/system/embedding/status', async (c) => {
  const t: TFunc = c.get('t')
  const pidPath = getEmbeddingPidPath()
  const pid = readPidFile(pidPath)
  const running = pid !== null && isPidAlive(pid)

  let model = ''
  let uptime = 0
  let ready = false

  let requestCount = 0, textsEmbedded = 0

  if (running) {
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
  }

  const uptimeStr = uptime > 0
    ? (uptime > 3600 ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m` : `${Math.floor(uptime / 60)}m ${uptime % 60}s`)
    : '—'

  return c.html(html`
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${t('sys.embeddingStatus')}</div>
        <div class="stat-number" style="font-size:1.1rem">
          ${running && ready
            ? html`<span class="badge badge-set">${icon('check', 11)} ${t('sys.embeddingOnline')}</span>`
            : running
              ? html`<span class="badge" style="background:var(--mc-warning);color:#000">${icon('loader', 11)} Loading...</span>`
              : html`<span class="badge badge-missing">${icon('x', 11)} ${t('sys.embeddingOffline')}</span>`
          }
          ${pid ? html`<div style="font-size:0.7rem;color:var(--mc-text-dim);margin-top:0.25rem">PID ${pid}</div>` : ''}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('sys.embeddingModel')}</div>
        <div class="stat-number" style="font-size:0.85rem">${model || '—'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('send', 12)} ${t('sys.embeddingRequests')}</div>
        <div class="stat-number">${requestCount}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('file-text', 12)} ${t('sys.embeddingTexts')}</div>
        <div class="stat-number">${textsEmbedded}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('timer', 12)} Uptime</div>
        <div class="stat-number" style="font-size:1.1rem">${uptimeStr}</div>
      </div>
    </div>
    <div style="margin-top:0.5rem;display:flex;gap:0.5rem">
      ${running
        ? html`
          <button hx-post="/system/embedding/stop" hx-target="#embedding-status" hx-swap="innerHTML" class="btn-sm secondary outline">${icon('square', 11)} ${t('sys.embeddingStop')}</button>
          <button hx-post="/system/embedding/reset" hx-target="#embedding-status" hx-swap="innerHTML" class="btn-sm outline">${icon('refresh-cw', 11)} ${t('sys.embeddingReset')}</button>
        `
        : html`<button hx-post="/system/embedding/start" hx-target="#embedding-status" hx-swap="innerHTML" class="btn-sm">${icon('play', 11)} ${t('sys.embeddingStart')}</button>`
      }
    </div>
  `)
})

app.post('/system/embedding/reset', async (c) => {
  try {
    const { resetStats } = await import('../../embeddings.js')
    await resetStats()
  } catch {}
  // HX-Redirect to trigger re-fetch of status fragment
  c.header('HX-Trigger', 'embeddingRefresh')
  return c.html(html`<div hx-get="/system/embedding/status" hx-trigger="load" hx-target="#embedding-status" hx-swap="innerHTML"></div>`)
})

app.post('/system/embedding/start', (c) => {
  const root = getProjectRoot()
  const logPath = '/tmp/botva-embedding.log'
  const logFd = openSync(logPath, 'a')
  const child = spawn('node', ['dist/scripts/embedding-server.js'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  // Return a loading state, htmx will poll for actual status
  const t: TFunc = c.get('t')
  return c.html(html`
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${t('sys.embeddingStatus')}</div>
        <div class="stat-number" style="font-size:1.1rem">
          <span class="badge" style="background:var(--mc-warning);color:#000">${icon('loader', 11)} Starting...</span>
        </div>
      </div>
    </div>
    <div hx-get="/system/embedding/status" hx-trigger="load delay:3s" hx-target="#embedding-status" hx-swap="innerHTML"></div>
  `)
})

app.post('/system/embedding/stop', (c) => {
  const pid = readPidFile(getEmbeddingPidPath())
  if (pid && isPidAlive(pid)) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  const t: TFunc = c.get('t')
  return c.html(html`
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${t('sys.embeddingStatus')}</div>
        <div class="stat-number" style="font-size:1.1rem">
          <span class="badge badge-missing">${icon('x', 11)} ${t('sys.embeddingOffline')}</span>
        </div>
      </div>
    </div>
    <div style="margin-top:0.5rem">
      <button hx-post="/system/embedding/start" hx-target="#embedding-status" hx-swap="innerHTML" class="btn-sm">${icon('play', 11)} ${t('sys.embeddingStart')}</button>
    </div>
  `)
})

// Save system settings
app.post('/system/settings', async (c) => {
  const t: TFunc = c.get('t')
  const body = await c.req.parseBody()
  const hour = parseInt(String(body['consolidationHour'] ?? '4'), 10)
  if ([0, 2, 4].includes(hour)) {
    setSystemSetting('consolidationHour', hour)
  }
  return c.html(html`<div class="alert alert-success">${t('sys.settingsSaved')}</div>`)
})

// Toggle builtin tool on/off
app.post('/system/tool-toggle/:name', (c) => {
  const t: TFunc = c.get('t')
  const name = c.req.param('name')
  const env = getMergedEnv()
  const tools = getBuiltinToolDefs(env)
  const current = tools.find(t => t.name === name)
  if (current && !current.system) {
    setToolEnabled(name, !current.enabled)
  }
  return c.html(renderBuiltinToolsTable(getBuiltinToolDefs(env), t, getToolUsageStats()))
})

// Toggle MCP server on/off
app.post('/system/mcp-toggle/:name', (c) => {
  const t: TFunc = c.get('t')
  const name = c.req.param('name')
  const disabled = isServerDisabled(name)
  setServerEnabled(name, disabled) // flip: was disabled → enable, was enabled → disable
  return c.html(renderMcpTable(getMcpServersConfig(getMergedEnv()), getEnvBotMap(), t))
})

// Delete MCP server
app.delete('/system/mcp-delete/:name', (c) => {
  const t: TFunc = c.get('t')
  removeMcpServer(c.req.param('name'))
  return c.html(renderMcpTable(getMcpServersConfig(getMergedEnv()), getEnvBotMap(), t))
})

// Add MCP server form
app.get('/system/mcp-add', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const page = html`
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem">
      <a href="/system" style="color:var(--mc-text-dim);text-decoration:none">${icon('arrow-left', 16)}</a>
      <h2 style="margin:0">${icon('plus')} ${t('sys.addMcp')}</h2>
    </div>
    <form method="POST" action="/system/mcp-save" style="max-width:600px">
      <label>${t('sys.mcpName')} <small>${t('sys.mcpNameHint')}</small>
        <input type="text" name="name" required placeholder="my-server">
      </label>
      <label style="margin-top:0.5rem">${t('sys.mcpCommand')} <small>${t('sys.mcpCommandHint')}</small>
        <input type="text" name="command" required placeholder="npx">
      </label>
      <label style="margin-top:0.5rem">${t('sys.mcpArgs')} <small>${t('sys.mcpArgsHint')}</small>
        <input type="text" name="args" placeholder="-y my-mcp-server">
      </label>
      <label style="margin-top:0.5rem">${t('sys.mcpEnvVars')} <small>${t('sys.mcpEnvVarsHint')}</small>
        <input type="text" name="envVars" placeholder="MY_API_KEY, MY_SECRET">
      </label>
      <label style="margin-top:0.5rem">${t('sys.mcpPassthrough')} <small>${t('sys.mcpPassthroughHint')}</small>
        <input type="text" name="envPassthrough" placeholder="MY_API_KEY, MY_SECRET">
      </label>
      <div style="display:flex;gap:0.5rem;margin-top:1rem">
        <button type="submit">${icon('save', 13)} ${t('sys.mcpSave')}</button>
        <a href="/system" role="button" class="outline" style="text-decoration:none">${t('sys.cancel')}</a>
      </div>
    </form>
  `
  return c.html(layout(t('sys.addMcp'), page, '/system', t, lang))
})

// Edit MCP server form
app.get('/system/mcp-edit/:name', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = c.req.param('name')
  const server = getMcpServer(name)
  if (!server) return c.text('Not found', 404)

  const page = html`
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem">
      <a href="/system" style="color:var(--mc-text-dim);text-decoration:none">${icon('arrow-left', 16)}</a>
      <h2 style="margin:0">${icon('pencil')} ${t('sys.editMcp')}: <code>${name}</code></h2>
    </div>
    <form method="POST" action="/system/mcp-save?edit=${name}" style="max-width:600px">
      <input type="hidden" name="name" value="${name}">
      <label>${t('sys.mcpName')}
        <input type="text" name="name" value="${name}" readonly style="opacity:0.6">
      </label>
      <label style="margin-top:0.5rem">${t('sys.mcpCommand')}
        <input type="text" name="command" value="${server.command}" required>
      </label>
      <label style="margin-top:0.5rem">${t('sys.mcpArgs')} <small>${t('sys.mcpArgsHint')}</small>
        <input type="text" name="args" value="${server.args.join(' ')}">
      </label>
      <label style="margin-top:0.5rem">${t('sys.mcpEnvVars')} <small>${t('sys.mcpEnvVarsHint')}</small>
        <input type="text" name="envVars" value="${(server.envVars ?? []).join(', ')}">
      </label>
      <label style="margin-top:0.5rem">${t('sys.mcpPassthrough')} <small>${t('sys.mcpPassthroughHint')}</small>
        <input type="text" name="envPassthrough" value="${(server.envPassthrough ?? []).join(', ')}">
      </label>
      <div style="display:flex;gap:0.5rem;margin-top:1rem">
        <button type="submit">${icon('save', 13)} ${t('sys.mcpSave')}</button>
        <a href="/system" role="button" class="outline" style="text-decoration:none">${t('sys.cancel')}</a>
      </div>
    </form>
  `
  return c.html(layout(`${t('sys.editMcp')}: ${name}`, page, '/system', t, lang))
})

// Save MCP server (add or edit)
app.post('/system/mcp-save', async (c) => {
  const body = await c.req.parseBody()
  const editName = c.req.query('edit')
  const name = String(editName || body['name'] || '').trim()
  if (!name) return c.text('Name required', 400)

  const command = String(body['command'] || '').trim()
  const argsStr = String(body['args'] || '').trim()
  const envVarsStr = String(body['envVars'] || '').trim()
  const envPassStr = String(body['envPassthrough'] || '').trim()

  const args = argsStr ? argsStr.split(/\s+/) : []
  const envVars = envVarsStr ? envVarsStr.split(',').map(s => s.trim()).filter(Boolean) : undefined
  const envPassthrough = envPassStr ? envPassStr.split(',').map(s => s.trim()).filter(Boolean) : undefined

  const existing = getMcpServer(name)

  if (editName) {
    updateMcpServer(name, { command, args, envVars, envPassthrough })
  } else {
    addMcpServer(name, { command, args, envVars, envPassthrough, enabled: true })
  }

  return c.redirect('/system')
})

// Toggle skill on/off
app.post('/system/skill-toggle/:name', (c) => {
  const t: TFunc = c.get('t')
  const name = c.req.param('name')
  const skillsDir = getSkillsDir()
  const enabledPath = join(skillsDir, name, 'SKILL.md')
  const disabledPath = join(skillsDir, name, 'SKILL.md.off')

  if (existsSync(enabledPath)) {
    renameSync(enabledPath, disabledPath)
  } else if (existsSync(disabledPath)) {
    renameSync(disabledPath, enabledPath)
  }

  return c.html(renderSkillsTable(getProjectSkills(), t))
})

// Skill editor page
app.get('/system/skill-edit/:name', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = c.req.param('name')
  const skillsDir = getSkillsDir()
  const enabledPath = join(skillsDir, name, 'SKILL.md')
  const disabledPath = join(skillsDir, name, 'SKILL.md.off')
  const filePath = existsSync(enabledPath) ? enabledPath : existsSync(disabledPath) ? disabledPath : null

  if (!filePath) return c.text('Skill not found', 404)

  const content = readFileSync(filePath, 'utf-8')
  const tokens = estimateTokens(content)

  const page = html`
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem">
      <a href="/system" style="color:var(--mc-text-dim);text-decoration:none">${icon('arrow-left', 16)}</a>
      <h2 style="margin:0">${icon('pencil')} ${t('sys.editSkill')}: <code>${name}</code></h2>
      <small style="margin-left:auto">${formatTokens(tokens)} ${t('sys.tokens')}</small>
    </div>
    <form method="POST" action="/system/skill-save/${name}">
      <textarea name="content" class="code" style="width:100%;min-height:500px;resize:vertical">${content}</textarea>
      <div style="display:flex;gap:0.5rem;margin-top:0.75rem">
        <button type="submit">${icon('save', 13)} ${t('sys.mcpSave')}</button>
        <a href="/system" role="button" class="outline" style="text-decoration:none">${t('sys.cancel')}</a>
      </div>
    </form>
  `
  return c.html(layout(`${t('sys.editSkill')}: ${name}`, page, '/system', t, lang))
})

// Save skill
app.post('/system/skill-save/:name', async (c) => {
  const name = c.req.param('name')
  const skillsDir = getSkillsDir()
  const enabledPath = join(skillsDir, name, 'SKILL.md')
  const disabledPath = join(skillsDir, name, 'SKILL.md.off')
  const filePath = existsSync(enabledPath) ? enabledPath : existsSync(disabledPath) ? disabledPath : null

  if (!filePath) return c.text('Skill not found', 404)

  const body = await c.req.parseBody()
  const content = String(body['content'] ?? '')
  const { writeFileSync: writeFile } = await import('fs')
  writeFile(filePath, content)

  return c.redirect('/system')
})

export default app
