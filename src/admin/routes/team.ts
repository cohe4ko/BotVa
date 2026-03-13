import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { alert } from '../views/components.js'
import { getBotNames, getBotDir } from '../db-multi.js'
import { getProjectRoot } from '../db-multi.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { getBotStatus } from '../bot-control.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

interface TeamConfig {
  manager: string
  bots: Record<string, { description: string }>
}

function teamPath(): string {
  return resolve(getProjectRoot(), 'workspace', 'team.json')
}

function readTeam(): TeamConfig {
  const p = teamPath()
  if (!existsSync(p)) return { manager: '', bots: {} }
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return { manager: '', bots: {} }
  }
}

function writeTeam(config: TeamConfig): void {
  writeFileSync(teamPath(), JSON.stringify(config, null, 2) + '\n')
}

const app = new Hono<I18nEnv>()

app.get('/team', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const team = readTeam()
  const allBots = getBotNames()

  const content = html`
    <h2>${icon('users')} ${t('team.title')}</h2>
    <div id="team-alerts"></div>

    <h3>${icon('crown')} ${t('team.manager')}</h3>
    <form hx-post="/team/manager" hx-target="#team-alerts" hx-swap="innerHTML">
      <div class="grid">
        <label>
          <select name="manager">
            <option value="" ${!team.manager ? 'selected' : ''}>${t('team.notSet')}</option>
            ${allBots.map(b => html`<option value="${b}" ${b === team.manager ? 'selected' : ''}>${b}</option>`)}
          </select>
        </label>
        <button type="submit">${t('team.setManager')}</button>
      </div>
    </form>

    <h3>${icon('bot')} ${t('team.bots')}</h3>
    <table>
      <thead>
        <tr>
          <th>${t('team.bot')}</th>
          <th>${t('team.role')}</th>
          <th>${t('team.status')}</th>
          <th>${t('team.description')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${allBots.map(b => {
          const info = team.bots[b]
          const status = getBotStatus(b)
          const isManager = b === team.manager
          return html`
            <tr>
              <td><a href="/bot/${b}/config"><strong>${b}</strong></a></td>
              <td>${isManager
                ? html`<span class="badge" style="background:var(--pico-primary);color:white">${icon('crown', 12)} ${t('team.managerRole')}</span>`
                : html`<span class="badge">${t('team.workerRole')}</span>`
              }</td>
              <td>${status.running
                ? html`<span class="badge badge-running">${t('status.online')}</span>`
                : html`<span class="badge badge-stopped">${t('status.offline')}</span>`
              }</td>
              <td>
                <form hx-post="/team/bot/${b}" hx-target="#team-alerts" hx-swap="innerHTML" style="display:flex;gap:0.5rem;margin:0">
                  <input name="description" value="${info?.description ?? ''}" style="margin:0;flex:1" placeholder="${t('team.descPlaceholder')}">
                  <button type="submit" style="margin:0;width:auto">${t('team.save')}</button>
                </form>
              </td>
              <td>
                ${!isManager && info ? html`<button hx-post="/team/bot/${b}/remove" hx-target="#team-alerts" hx-swap="innerHTML" hx-confirm="${t('team.removeConfirm', { name: b })}" class="outline" style="margin:0;padding:0.25rem 0.5rem">${icon('x', 12)}</button>` : ''}
              </td>
            </tr>
          `
        })}
      </tbody>
    </table>

    <details>
      <summary>${icon('file-json')} ${t('team.rawJson')}</summary>
      <pre style="margin-top:0.5rem"><code>${JSON.stringify(team, null, 2)}</code></pre>
    </details>
  `

  return c.html(layout(t('team.title'), content, '/team', t, lang))
})

app.post('/team/manager', async (c) => {
  const t: TFunc = c.get('t')
  const body = await c.req.parseBody()
  const manager = String(body['manager'] ?? '')
  const team = readTeam()
  team.manager = manager

  // Ensure manager bot is in the bots list
  if (manager && !team.bots[manager]) {
    team.bots[manager] = { description: '' }
  }

  writeTeam(team)
  return c.html(alert('success', manager ? t('team.managerSet', { name: manager }) : t('team.managerCleared')))
})

app.post('/team/bot/:name', async (c) => {
  const t: TFunc = c.get('t')
  const name = c.req.param('name')
  const body = await c.req.parseBody()
  const description = String(body['description'] ?? '')
  const team = readTeam()

  if (!team.bots[name]) {
    team.bots[name] = { description }
  } else {
    team.bots[name].description = description
  }

  writeTeam(team)
  return c.html(alert('success', t('team.descSaved', { name })))
})

app.post('/team/bot/:name/remove', async (c) => {
  const t: TFunc = c.get('t')
  const name = c.req.param('name')
  const team = readTeam()

  if (name === team.manager) {
    return c.html(alert('error', t('team.cantRemoveManager')))
  }

  delete team.bots[name]
  writeTeam(team)
  return c.html(alert('success', t('team.removed', { name })))
})

export default app
