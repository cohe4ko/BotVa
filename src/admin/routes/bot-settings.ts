import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav } from '../views/layout.js'
import { alert } from '../views/components.js'
import { getSettings, upsertSetting, deleteSetting } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

app.get('/bot/:name/settings', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  let settings: ReturnType<typeof getSettings> = []
  try { settings = getSettings(name) } catch { /* db may not exist */ }

  const content = html`
    ${botNav(name, 'settings', t)}
    <h3>${t('settings.title')}</h3>
    <div id="settings-alerts"></div>
    <details>
      <summary>${t('settings.addUpdate')}</summary>
      <form hx-post="/bot/${name}/settings" hx-target="#settings-alerts" hx-swap="innerHTML">
        <div class="grid">
          <label>${t('settings.chatId')}<input type="text" name="chat_id" required></label>
          <label>${t('settings.key')}<input type="text" name="key" required placeholder="${t('settings.keyPlaceholder')}"></label>
          <label>${t('settings.value')}<input type="text" name="value" required placeholder="${t('settings.valuePlaceholder')}"></label>
        </div>
        <button type="submit">${t('settings.save')}</button>
      </form>
    </details>
    <table>
      <thead><tr><th>${t('settings.chatId')}</th><th>${t('settings.key')}</th><th>${t('settings.value')}</th><th></th></tr></thead>
      <tbody>
        ${settings.map(s => html`
          <tr id="setting-${s.chat_id}-${s.key}">
            <td>${s.chat_id}</td>
            <td><code>${s.key}</code></td>
            <td>${s.value}</td>
            <td><button hx-delete="/bot/${name}/settings?chat_id=${s.chat_id}&key=${s.key}"
              hx-target="#setting-${s.chat_id}-${s.key}" hx-swap="outerHTML" hx-confirm="${t('settings.deleteConfirm')}"
              class="secondary outline" style="padding:0.2rem 0.5rem;font-size:0.8rem">${t('mem.del')}</button></td>
          </tr>
        `)}
        ${settings.length === 0 ? html`<tr><td colspan="4">${t('settings.noSettings')}</td></tr>` : ''}
      </tbody>
    </table>
  `
  return c.html(layout(`${name} ${t('botnav.settings')}`, content, `/bot/${name}`, t, lang))
})

app.post('/bot/:name/settings', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const body = await c.req.parseBody()
  const chatId = String(body['chat_id'] ?? ''), key = String(body['key'] ?? ''), value = String(body['value'] ?? '')
  if (!chatId || !key) return c.html(alert('error', t('settings.required')))
  upsertSetting(name, chatId, key, value)
  return c.html(alert('success', t('settings.saved', { key })))
})

app.delete('/bot/:name/settings', validateBot, (c) => {
  const name = botName(c)
  const chatId = c.req.query('chat_id') || '', key = c.req.query('key') || ''
  if (!chatId || !key) return c.text('missing params', 400)
  deleteSetting(name, chatId, key)
  return c.html(html``)
})

export default app
