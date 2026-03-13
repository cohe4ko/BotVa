import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { formatCost } from '../views/components.js'
import { getBotNames, getUsageSummary, getBotDir, getProjectRoot } from '../db-multi.js'
import { readEnv } from '../env-parser.js'
import { getMcpServersConfig, isServerDisabled, setServerEnabled, addMcpServer, removeMcpServer, getMcpServer, updateMcpServer, type McpServerEntry } from '../../mcp-config.js'
import { existsSync, readdirSync, renameSync, readFileSync } from 'fs'
import { resolve, join } from 'path'
import { execSync } from 'child_process'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

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
    <div class="stats-grid">
      ${[
        { ic: 'terminal', name: t('sys.bash'), desc: t('sys.bashDesc') },
        { ic: 'folder', name: t('sys.fileSystem'), desc: t('sys.fileSystemDesc') },
        { ic: 'search', name: t('sys.webSearch'), desc: t('sys.webSearchDesc') },
        { ic: 'globe', name: t('sys.webFetch'), desc: t('sys.webFetchDesc') },
        { ic: 'image', name: t('sys.imageGen'), desc: t('sys.imageGenDesc') },
        { ic: 'pen-tool', name: t('sys.imageEdit'), desc: t('sys.imageEditDesc') },
        { ic: 'mic', name: t('sys.voiceStt'), desc: t('sys.voiceSttDesc') },
        { ic: 'volume-2', name: t('sys.voiceTts'), desc: t('sys.voiceTtsDesc') },
        { ic: 'newspaper', name: t('sys.telegraph'), desc: t('sys.telegraphDesc') },
        { ic: 'upload', name: t('sys.fileShare'), desc: t('sys.fileShareDesc') },
      ].map(tool => html`
        <div class="stat-card" style="padding:0.7rem">
          <div style="margin-bottom:0.2rem;color:var(--mc-text-dim)">${icon(tool.ic, 16)}</div>
          <div style="font-weight:600;font-size:0.82rem">${tool.name}</div>
          <div style="font-size:0.72rem;color:var(--mc-text-dim)">${tool.desc}</div>
        </div>
      `)}
    </div>

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
