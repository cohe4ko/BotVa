import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { alert } from '../views/components.js'
import { getBotNames, getBotDir } from '../db-multi.js'
import { getProjectRoot } from '../db-multi.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { getBotStatus } from '../bot-control.js'

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

const app = new Hono()

app.get('/team', (c) => {
  const team = readTeam()
  const allBots = getBotNames()

  const content = html`
    <h2>${icon('users')} Team</h2>
    <div id="team-alerts"></div>

    <h3>${icon('crown')} Manager</h3>
    <form hx-post="/team/manager" hx-target="#team-alerts" hx-swap="innerHTML">
      <div class="grid">
        <label>
          <select name="manager">
            <option value="" ${!team.manager ? 'selected' : ''}>(not set)</option>
            ${allBots.map(b => html`<option value="${b}" ${b === team.manager ? 'selected' : ''}>${b}</option>`)}
          </select>
        </label>
        <button type="submit">Set Manager</button>
      </div>
    </form>

    <h3>${icon('bot')} Bots</h3>
    <table>
      <thead>
        <tr>
          <th>Bot</th>
          <th>Role</th>
          <th>Status</th>
          <th>Description</th>
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
                ? html`<span class="badge" style="background:var(--pico-primary);color:white">${icon('crown', 12)} manager</span>`
                : html`<span class="badge">worker</span>`
              }</td>
              <td>${status.running
                ? html`<span class="badge badge-running">online</span>`
                : html`<span class="badge badge-stopped">offline</span>`
              }</td>
              <td>
                <form hx-post="/team/bot/${b}" hx-target="#team-alerts" hx-swap="innerHTML" style="display:flex;gap:0.5rem;margin:0">
                  <input name="description" value="${info?.description ?? ''}" style="margin:0;flex:1" placeholder="Опис бота...">
                  <button type="submit" style="margin:0;width:auto">Save</button>
                </form>
              </td>
              <td>
                ${!isManager && info ? html`<button hx-post="/team/bot/${b}/remove" hx-target="#team-alerts" hx-swap="innerHTML" hx-confirm="Remove ${b} from team?" class="outline" style="margin:0;padding:0.25rem 0.5rem">${icon('x', 12)}</button>` : ''}
              </td>
            </tr>
          `
        })}
      </tbody>
    </table>

    <details>
      <summary>${icon('file-json')} Raw team.json</summary>
      <pre style="margin-top:0.5rem"><code>${JSON.stringify(team, null, 2)}</code></pre>
    </details>
  `

  return c.html(layout('Team', content, '/team'))
})

app.post('/team/manager', async (c) => {
  const body = await c.req.parseBody()
  const manager = String(body['manager'] ?? '')
  const team = readTeam()
  team.manager = manager

  // Ensure manager bot is in the bots list
  if (manager && !team.bots[manager]) {
    team.bots[manager] = { description: '' }
  }

  writeTeam(team)
  return c.html(alert('success', manager ? `Manager set to: ${manager}` : 'Manager cleared'))
})

app.post('/team/bot/:name', async (c) => {
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
  return c.html(alert('success', `${name} description saved`))
})

app.post('/team/bot/:name/remove', async (c) => {
  const name = c.req.param('name')
  const team = readTeam()

  if (name === team.manager) {
    return c.html(alert('error', 'Cannot remove manager from team'))
  }

  delete team.bots[name]
  writeTeam(team)
  return c.html(alert('success', `${name} removed from team`))
})

export default app
