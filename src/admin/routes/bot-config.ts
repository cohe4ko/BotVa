import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { alert } from '../views/components.js'
import { readEnvRaw, writeEnvRaw, readClaudeMd, writeClaudeMd, readEnv } from '../env-parser.js'
import { getBotStatus, stopBot } from '../bot-control.js'
import { validateBot, botName } from '../bot-middleware.js'
import { getSettings, upsertSetting, getBotDir, getProjectRoot } from '../db-multi.js'
import { validateEnv, verifyTelegramToken } from '../env-validator.js'
import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'fs'
import { resolve } from 'path'

const MODELS = [
  { id: 'opus', label: 'Opus — Most capable' },
  { id: 'sonnet', label: 'Sonnet — Balanced' },
  { id: 'haiku', label: 'Haiku — Fast & light' },
]

function getAgentSettings(name: string): { model: string; temperature: string } {
  try {
    const settings = getSettings(name)
    const chatId = readEnv(name)['ALLOWED_CHAT_ID'] ?? ''
    const modelSetting = settings.find(s => s.key === 'model' && s.chat_id === chatId)
    const tempSetting = settings.find(s => s.key === 'temperature' && s.chat_id === chatId)
    return {
      model: modelSetting?.value ?? 'sonnet',
      temperature: tempSetting?.value ?? '1',
    }
  } catch {
    return { model: 'sonnet', temperature: '1' }
  }
}

const app = new Hono()

app.get('/bot/:name/config', validateBot, (c) => {
  const name = botName(c)
  const envContent = readEnvRaw(name)
  const claudeContent = readClaudeMd(name)
  const status = getBotStatus(name)

  const agentSettings = getAgentSettings(name)

  const content = html`
    ${botNav(name, 'config')}
    <div id="config-alerts"></div>

    <h3>${icon('cpu')} Agent Settings</h3>
    <form hx-post="/bot/${name}/config/agent" hx-target="#config-alerts" hx-swap="innerHTML">
      <div class="grid">
        <label>Model
          <select name="model">
            ${MODELS.map(m => html`<option value="${m.id}" ${m.id === agentSettings.model ? 'selected' : ''}>${m.label}</option>`)}
          </select>
        </label>
        <label>Temperature: <output id="temp-val">${agentSettings.temperature}</output>
          <input type="range" name="temperature" min="0" max="1" step="0.1" value="${agentSettings.temperature}"
            oninput="document.getElementById('temp-val').textContent=this.value">
          <small style="display:block;color:var(--pico-muted-color);margin-top:4px">
            0 — strict, deterministic (code, math, data extraction)<br>
            0.3–0.5 — balanced (analysis, summaries, structured answers)<br>
            0.7–0.8 — creative writing, brainstorming<br>
            1.0 — maximum creativity and variety
          </small>
        </label>
      </div>
      <button type="submit">Save Agent Settings</button>
    </form>

    <h3>${icon('file-key')} Environment</h3>
    <form hx-post="/bot/${name}/config/env" hx-target="#config-alerts" hx-swap="innerHTML">
      <textarea name="env" class="code" rows="15" style="width:100%">${envContent}</textarea>
      <div class="btn-group">
        <button type="submit">Save .env</button>
        <button type="button" hx-post="/bot/${name}/config/verify-token" hx-target="#config-alerts" hx-swap="innerHTML" class="outline">Verify Token</button>
        ${status.running ? html`<button type="button" hx-post="/bot/${name}/restart" hx-target="#config-alerts" hx-swap="innerHTML" class="contrast outline">Restart bot</button>` : ''}
      </div>
    </form>

    <h3>${icon('file-pen')} Personality (CLAUDE.md)</h3>
    <form hx-post="/bot/${name}/config/claude" hx-target="#config-alerts" hx-swap="innerHTML">
      <textarea name="claude" class="code" rows="20" style="width:100%">${claudeContent}</textarea>
      <button type="submit">Save CLAUDE.md</button>
    </form>

    <details style="margin-top:2rem">
      <summary style="cursor:pointer">${icon('pencil')} Rename bot</summary>
      <form method="POST" action="/bot/${name}/rename" style="margin-top:0.5rem">
        <div style="display:flex;gap:0.5rem;align-items:end">
          <label style="flex:1">New name (lowercase, no spaces)
            <input type="text" name="new_name" required pattern="[a-z][a-z0-9_-]*" placeholder="${name}"
              title="Lowercase letters, digits, hyphens, underscores. Start with a letter.">
          </label>
          <button type="submit" style="margin-bottom:0">Rename</button>
        </div>
      </form>
    </details>

    <details style="margin-top:0.5rem">
      <summary style="color:var(--pico-del-color);cursor:pointer">${icon('trash-2')} Delete bot</summary>
      <p style="margin-top:0.5rem">Bot folder will be archived to <code>workspace/archive/</code> before deletion.</p>
      <form method="POST" action="/bot/${name}/delete" onsubmit="return confirm('Delete bot ${name}? Archive will be saved to workspace/archive/')">
        <button type="submit" class="secondary" style="background:var(--pico-del-color);border-color:var(--pico-del-color)">Archive & Delete ${name}</button>
      </form>
    </details>
  `

  return c.html(layout(`${name} Config`, content, `/bot/${name}`))
})

app.post('/bot/:name/config/agent', validateBot, async (c) => {
  const name = botName(c)
  const body = await c.req.parseBody()
  const model = String(body['model'] ?? 'sonnet')
  const temperature = String(body['temperature'] ?? '1')
  const chatId = readEnv(name)['ALLOWED_CHAT_ID'] ?? ''
  if (!chatId) {
    return c.html(alert('warning', 'No ALLOWED_CHAT_ID set. Configure .env first.'))
  }
  const validModels = MODELS.map(m => m.id)
  if (!validModels.includes(model)) {
    return c.html(alert('error', 'Invalid model.'))
  }
  const temp = parseFloat(temperature)
  if (isNaN(temp) || temp < 0 || temp > 1) {
    return c.html(alert('error', 'Temperature must be 0-1.'))
  }
  try {
    upsertSetting(name, chatId, 'model', model)
    upsertSetting(name, chatId, 'temperature', temperature)
  } catch {
    return c.html(alert('warning', 'Agent settings not saved — bot has never been started (no database yet). Start the bot first.'))
  }
  return c.html(alert('success', `Agent settings saved: model=${model}, temperature=${temperature}`))
})

app.post('/bot/:name/config/env', validateBot, async (c) => {
  const name = botName(c)
  const body = await c.req.parseBody()
  const envRaw = String(body['env'] ?? '')

  // Parse and validate
  const parsed: Record<string, string> = {}
  for (const line of envRaw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    let val = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    parsed[trimmed.slice(0, eqIdx).trim()] = val
  }

  const errors = validateEnv(parsed)
  if (errors.length > 0) {
    writeEnvRaw(name, envRaw) // Save anyway, but warn
    return c.html(html`
      ${alert('warning', '.env saved with validation warnings:')}
      <ul style="margin:0.5rem 0">
        ${errors.map(e => html`<li><b>${e.key}</b>: ${e.message}</li>`)}
      </ul>
      <small>Restart required for changes to take effect.</small>
    `)
  }

  writeEnvRaw(name, envRaw)
  return c.html(alert('success', '.env saved. Restart required for changes to take effect.'))
})

app.post('/bot/:name/config/verify-token', validateBot, async (c) => {
  const name = botName(c)
  const env = readEnv(name)
  const token = env['TELEGRAM_BOT_TOKEN']
  if (!token) {
    return c.html(alert('error', 'No TELEGRAM_BOT_TOKEN in .env'))
  }
  const result = await verifyTelegramToken(token)
  if (result.ok) {
    return c.html(alert('success', `Token valid: ${result.botName}`))
  }
  return c.html(alert('error', `Token invalid: ${result.error}`))
})

app.post('/bot/:name/config/claude', validateBot, async (c) => {
  const name = botName(c)
  const body = await c.req.parseBody()
  writeClaudeMd(name, String(body['claude'] ?? ''))
  return c.html(alert('success', 'CLAUDE.md saved.'))
})

app.post('/bot/:name/rename', validateBot, async (c) => {
  const name = botName(c)
  const body = await c.req.parseBody()
  const newName = String(body['new_name'] ?? '').toLowerCase().trim()

  if (!newName || !/^[a-z][a-z0-9_-]*$/.test(newName)) {
    return c.html(layout('Rename Bot', html`${alert('error', 'Invalid name. Lowercase letters, digits, hyphens.')} <a href="/bot/${name}/config">Back</a>`, `/bot/${name}`))
  }
  if (newName === name) {
    return c.redirect(`/bot/${name}/config`)
  }

  const root = getProjectRoot()
  const oldDir = resolve(root, 'bots', name)
  const newDir = resolve(root, 'bots', newName)

  if (existsSync(newDir)) {
    return c.html(layout('Rename Bot', html`${alert('error', `Bot "${newName}" already exists.`)} <a href="/bot/${name}/config">Back</a>`, `/bot/${name}`))
  }

  // Stop bot
  stopBot(name)
  await new Promise(r => setTimeout(r, 500))

  // Rename directory
  renameSync(oldDir, newDir)

  // Update team.json
  const teamPath = resolve(root, 'workspace', 'team.json')
  if (existsSync(teamPath)) {
    try {
      const team = JSON.parse(readFileSync(teamPath, 'utf-8'))
      if (team.bots?.[name]) {
        team.bots[newName] = team.bots[name]
        delete team.bots[name]
        if (team.manager === name) team.manager = newName
        writeFileSync(teamPath, JSON.stringify(team, null, 2) + '\n')
      }
    } catch { /* ignore */ }
  }

  return c.redirect(`/bot/${newName}/config`)
})

app.post('/bot/:name/delete', validateBot, async (c) => {
  const name = botName(c)
  const root = getProjectRoot()
  const botDir = getBotDir(name)

  // Stop bot if running
  stopBot(name)
  await new Promise(r => setTimeout(r, 500))

  // Archive
  const archiveDir = resolve(root, 'workspace', 'archive')
  mkdirSync(archiveDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const archiveName = `${name}_${ts}.tar.gz`
  const archivePath = resolve(archiveDir, archiveName)

  try {
    execSync(`tar -czf "${archivePath}" -C "${resolve(root, 'bots')}" "${name}"`, { timeout: 30000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(layout('Delete Bot', html`${alert('error', `Archive failed: ${msg}`)} <a href="/bot/${name}/config">Back</a>`, `/bot/${name}`))
  }

  // Remove bot directory
  rmSync(botDir, { recursive: true, force: true })

  // Remove from team.json
  const teamPath = resolve(root, 'workspace', 'team.json')
  if (existsSync(teamPath)) {
    try {
      const team = JSON.parse(readFileSync(teamPath, 'utf-8'))
      delete team.bots[name]
      writeFileSync(teamPath, JSON.stringify(team, null, 2) + '\n')
    } catch { /* ignore */ }
  }

  const content = html`
    ${alert('success', `Bot "${name}" archived and deleted.`)}
    <p>Archive: <code>workspace/archive/${archiveName}</code></p>
    <p>To restore: <code>tar -xzf workspace/archive/${archiveName} -C bots/</code></p>
    <a href="/" role="button">Dashboard</a>
  `
  return c.html(layout('Bot Deleted', content, '/'))
})

export default app
