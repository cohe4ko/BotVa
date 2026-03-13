import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav } from '../views/layout.js'
import { alert } from '../views/components.js'
import { getSettings, upsertSetting, deleteSetting } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'

const app = new Hono()

app.get('/bot/:name/settings', validateBot, (c) => {
  const name = botName(c)
  let settings: ReturnType<typeof getSettings> = []
  try { settings = getSettings(name) } catch { /* db may not exist */ }

  const content = html`
    ${botNav(name, 'settings')}
    <h3>Chat Settings</h3>
    <div id="settings-alerts"></div>
    <details>
      <summary>Add / Update setting</summary>
      <form hx-post="/bot/${name}/settings" hx-target="#settings-alerts" hx-swap="innerHTML">
        <div class="grid">
          <label>Chat ID<input type="text" name="chat_id" required></label>
          <label>Key<input type="text" name="key" required placeholder="e.g. stats_enabled"></label>
          <label>Value<input type="text" name="value" required placeholder="e.g. true"></label>
        </div>
        <button type="submit">Save</button>
      </form>
    </details>
    <table>
      <thead><tr><th>Chat ID</th><th>Key</th><th>Value</th><th></th></tr></thead>
      <tbody>
        ${settings.map(s => html`
          <tr id="setting-${s.chat_id}-${s.key}">
            <td>${s.chat_id}</td>
            <td><code>${s.key}</code></td>
            <td>${s.value}</td>
            <td><button hx-delete="/bot/${name}/settings?chat_id=${s.chat_id}&key=${s.key}"
              hx-target="#setting-${s.chat_id}-${s.key}" hx-swap="outerHTML" hx-confirm="Delete?"
              class="secondary outline" style="padding:0.2rem 0.5rem;font-size:0.8rem">Del</button></td>
          </tr>
        `)}
        ${settings.length === 0 ? html`<tr><td colspan="4">No settings</td></tr>` : ''}
      </tbody>
    </table>
  `
  return c.html(layout(`${name} Settings`, content, `/bot/${name}`))
})

app.post('/bot/:name/settings', validateBot, async (c) => {
  const name = botName(c)
  const body = await c.req.parseBody()
  const chatId = String(body['chat_id'] ?? ''), key = String(body['key'] ?? ''), value = String(body['value'] ?? '')
  if (!chatId || !key) return c.html(alert('error', 'Chat ID and Key are required'))
  upsertSetting(name, chatId, key, value)
  return c.html(alert('success', `Setting ${key} saved. Reload to see it.`))
})

app.delete('/bot/:name/settings', validateBot, (c) => {
  const name = botName(c)
  const chatId = c.req.query('chat_id') || '', key = c.req.query('key') || ''
  if (!chatId || !key) return c.text('missing params', 400)
  deleteSetting(name, chatId, key)
  return c.html(html``)
})

export default app
