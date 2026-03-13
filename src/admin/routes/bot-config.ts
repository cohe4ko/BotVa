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
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

function getModelLabels(t: TFunc) {
  return [
    { id: 'opus', label: t('config.opusDesc') },
    { id: 'sonnet', label: t('config.sonnetDesc') },
    { id: 'haiku', label: t('config.haikuDesc') },
  ]
}

const MODEL_IDS = ['opus', 'sonnet', 'haiku']

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

const app = new Hono<I18nEnv>()

app.get('/bot/:name/config', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const envContent = readEnvRaw(name)
  const claudeContent = readClaudeMd(name)
  const status = getBotStatus(name)
  const MODELS = getModelLabels(t)

  const agentSettings = getAgentSettings(name)

  const content = html`
    ${botNav(name, 'config', t)}
    <div id="config-alerts"></div>

    <h3>${icon('cpu')} ${t('config.agentSettings')}</h3>
    <form hx-post="/bot/${name}/config/agent" hx-target="#config-alerts" hx-swap="innerHTML">
      <div class="grid">
        <label>${t('config.model')}
          <select name="model">
            ${MODELS.map(m => html`<option value="${m.id}" ${m.id === agentSettings.model ? 'selected' : ''}>${m.label}</option>`)}
          </select>
        </label>
        <label>${t('config.temperature')}: <output id="temp-val">${agentSettings.temperature}</output>
          <input type="range" name="temperature" min="0" max="1" step="0.1" value="${agentSettings.temperature}"
            oninput="document.getElementById('temp-val').textContent=this.value">
          <small style="display:block;color:var(--pico-muted-color);margin-top:4px">
            ${t('config.tempStrict')}<br>
            ${t('config.tempBalanced')}<br>
            ${t('config.tempCreative')}<br>
            ${t('config.tempMax')}
          </small>
        </label>
      </div>
      <button type="submit">${t('config.saveAgent')}</button>
    </form>

    <h3>${icon('file-key')} ${t('config.environment')}</h3>
    <form hx-post="/bot/${name}/config/env" hx-target="#config-alerts" hx-swap="innerHTML">
      <textarea name="env" class="code" rows="15" style="width:100%">${envContent}</textarea>
      <div class="btn-group">
        <button type="submit">${t('config.saveEnv')}</button>
        <button type="button" hx-post="/bot/${name}/config/verify-token" hx-target="#config-alerts" hx-swap="innerHTML" class="outline">${t('config.verifyToken')}</button>
        ${status.running ? html`<button type="button" hx-post="/bot/${name}/restart" hx-target="#config-alerts" hx-swap="innerHTML" class="contrast outline">${t('config.restartBot')}</button>` : ''}
      </div>
    </form>

    <h3>${icon('file-pen')} ${t('config.personality')}</h3>
    <form hx-post="/bot/${name}/config/claude" hx-target="#config-alerts" hx-swap="innerHTML">
      <textarea name="claude" class="code" rows="20" style="width:100%">${claudeContent}</textarea>
      <button type="submit">${t('config.saveClaude')}</button>
    </form>

    <details style="margin-top:2rem">
      <summary style="cursor:pointer">${icon('pencil')} ${t('config.rename')}</summary>
      <form method="POST" action="/bot/${name}/rename" style="margin-top:0.5rem">
        <div style="display:flex;gap:0.5rem;align-items:end">
          <label style="flex:1">${t('config.newName')}
            <input type="text" name="new_name" required pattern="[a-z][a-z0-9_-]*" placeholder="${name}"
              title="${t('config.nameHint')}">
          </label>
          <button type="submit" style="margin-bottom:0">${t('config.renameBtn')}</button>
        </div>
      </form>
    </details>

    <details style="margin-top:0.5rem">
      <summary style="color:var(--pico-del-color);cursor:pointer">${icon('trash-2')} ${t('config.delete')}</summary>
      <p style="margin-top:0.5rem">${t('config.deleteArchiveNote')}</p>
      <form method="POST" action="/bot/${name}/delete" onsubmit="return confirm('${t('config.deleteConfirm', { name })}')">
        <button type="submit" class="secondary" style="background:var(--pico-del-color);border-color:var(--pico-del-color)">${t('config.deleteBtn', { name })}</button>
      </form>
    </details>
  `

  return c.html(layout(`${name} ${t('botnav.config')}`, content, `/bot/${name}`, t, lang))
})

app.post('/bot/:name/config/agent', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const body = await c.req.parseBody()
  const model = String(body['model'] ?? 'sonnet')
  const temperature = String(body['temperature'] ?? '1')
  const chatId = readEnv(name)['ALLOWED_CHAT_ID'] ?? ''
  if (!chatId) {
    return c.html(alert('warning', t('config.noChatId')))
  }
  if (!MODEL_IDS.includes(model)) {
    return c.html(alert('error', t('config.invalidModel')))
  }
  const temp = parseFloat(temperature)
  if (isNaN(temp) || temp < 0 || temp > 1) {
    return c.html(alert('error', t('config.tempRange')))
  }
  try {
    upsertSetting(name, chatId, 'model', model)
    upsertSetting(name, chatId, 'temperature', temperature)
  } catch {
    return c.html(alert('warning', t('config.noDb')))
  }
  return c.html(alert('success', t('config.agentSaved', { model, temperature })))
})

app.post('/bot/:name/config/env', validateBot, async (c) => {
  const t: TFunc = c.get('t')
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
      ${alert('warning', t('config.envWarnings'))}
      <ul style="margin:0.5rem 0">
        ${errors.map(e => html`<li><b>${e.key}</b>: ${e.message}</li>`)}
      </ul>
      <small>${t('config.restartRequired')}</small>
    `)
  }

  writeEnvRaw(name, envRaw)
  return c.html(alert('success', t('config.envSaved')))
})

app.post('/bot/:name/config/verify-token', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const env = readEnv(name)
  const token = env['TELEGRAM_BOT_TOKEN']
  if (!token) {
    return c.html(alert('error', t('config.noTelegramToken')))
  }
  const result = await verifyTelegramToken(token)
  if (result.ok) {
    return c.html(alert('success', t('config.tokenValid', { name: result.botName ?? '' })))
  }
  return c.html(alert('error', t('config.tokenInvalid', { error: result.error ?? '' })))
})

app.post('/bot/:name/config/claude', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const body = await c.req.parseBody()
  writeClaudeMd(name, String(body['claude'] ?? ''))
  return c.html(alert('success', t('config.claudeSaved')))
})

app.post('/bot/:name/rename', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const body = await c.req.parseBody()
  const newName = String(body['new_name'] ?? '').toLowerCase().trim()

  if (!newName || !/^[a-z][a-z0-9_-]*$/.test(newName)) {
    return c.html(layout(t('config.rename'), html`${alert('error', t('config.invalidName'))} <a href="/bot/${name}/config">${t('common.back')}</a>`, `/bot/${name}`, t, lang))
  }
  if (newName === name) {
    return c.redirect(`/bot/${name}/config`)
  }

  const root = getProjectRoot()
  const oldDir = resolve(root, 'bots', name)
  const newDir = resolve(root, 'bots', newName)

  if (existsSync(newDir)) {
    return c.html(layout(t('config.rename'), html`${alert('error', t('config.botExists', { name: newName }))} <a href="/bot/${name}/config">${t('common.back')}</a>`, `/bot/${name}`, t, lang))
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
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const root = getProjectRoot()
  const botDir = getBotDir(name)

  // Stop bot if running
  stopBot(name)
  await new Promise(r => setTimeout(r, 500))

  // Archive
  const archiveDir = resolve(root, 'archive')
  mkdirSync(archiveDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const archiveName = `${name}_${ts}.tar.gz`
  const archivePath = resolve(archiveDir, archiveName)

  try {
    execSync(`tar -czf "${archivePath}" -C "${resolve(root, 'bots')}" "${name}"`, { timeout: 30000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(layout(t('config.delete'), html`${alert('error', `Archive failed: ${msg}`)} <a href="/bot/${name}/config">${t('common.back')}</a>`, `/bot/${name}`, t, lang))
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
    ${alert('success', t('config.botDeleted', { name }))}
    <p>${t('config.archivePath', { archive: archiveName })}</p>
    <p>${t('config.restoreHint', { archive: archiveName })}</p>
    <a href="/" role="button">${t('nav.dashboard')}</a>
  `
  return c.html(layout(t('config.delete'), content, '/', t, lang))
})

export default app
