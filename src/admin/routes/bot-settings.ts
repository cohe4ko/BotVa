import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav } from '../views/layout.js'
import { alert, formatTs } from '../views/components.js'
import { getSettings, upsertSetting, deleteSetting, getSessions, deleteSession } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import { listDiskSessions } from '../disk-sessions.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')

const app = new Hono<I18nEnv>()

app.get('/bot/:name/settings', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  let settings: ReturnType<typeof getSettings> = []
  let sessions: ReturnType<typeof getSessions> = []
  try { settings = getSettings(name) } catch { /* db may not exist */ }
  try { sessions = getSessions(name) } catch { /* db may not exist */ }
  const botDir = resolve(PROJECT_ROOT, 'bots', name)
  const diskSessions = listDiskSessions(botDir)

  const content = html`
    ${botNav(name, 'settings', t)}

    <!-- Settings -->
    <div class="section-header">
      <h3 style="margin:0">${t('settings.title')}</h3>
      <small>${settings.length} ${settings.length === 1 ? 'setting' : 'settings'}</small>
    </div>
    <div id="settings-alerts"></div>
    <details style="margin-bottom:1rem">
      <summary><i data-lucide="plus" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('settings.addUpdate')}</summary>
      <form hx-post="/bot/${name}/settings" hx-target="#settings-alerts" hx-swap="innerHTML">
        <div class="grid">
          <label>${t('settings.chatId')}<input type="text" name="chat_id" required></label>
          <label>${t('settings.key')}<input type="text" name="key" required placeholder="${t('settings.keyPlaceholder')}"></label>
          <label>${t('settings.value')}<input type="text" name="value" required placeholder="${t('settings.valuePlaceholder')}"></label>
        </div>
        <button type="submit" style="margin-top:0.75rem"><i data-lucide="save" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('settings.save')}</button>
      </form>
    </details>
    ${settings.length === 0
      ? html`<div class="empty-state"><div class="empty-icon"><i data-lucide="sliders-horizontal" style="width:32px;height:32px"></i></div><p>${t('settings.noSettings')}</p></div>`
      : html`
        <div class="table-wrap">
          <table>
            <thead><tr><th>${t('settings.chatId')}</th><th>${t('settings.key')}</th><th>${t('settings.value')}</th><th style="width:60px"></th></tr></thead>
            <tbody>
              ${settings.map(s => html`
                <tr id="setting-${s.chat_id}-${s.key}">
                  <td><small>${s.chat_id}</small></td>
                  <td><code>${s.key}</code></td>
                  <td>${s.value}</td>
                  <td><button hx-delete="/bot/${name}/settings?chat_id=${s.chat_id}&key=${s.key}"
                    hx-target="#setting-${s.chat_id}-${s.key}" hx-swap="outerHTML" hx-confirm="${t('settings.deleteConfirm')}"
                    class="danger btn-sm"><i data-lucide="trash-2" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button></td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      `
    }

    <!-- Active Session (SQLite) -->
    <div class="section-header" style="margin-top:2rem">
      <h3 style="margin:0"><i data-lucide="link" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('sess.title')}</h3>
      <small>${sessions.length} active</small>
    </div>
    ${sessions.length === 0
      ? html`<div class="empty-state"><div class="empty-icon"><i data-lucide="link" style="width:32px;height:32px"></i></div><p>${t('sess.noSessions')}</p></div>`
      : html`
        <div class="table-wrap">
          <table>
            <thead><tr><th>${t('sess.chatId')}</th><th>${t('sess.sessionId')}</th><th style="width:170px">${t('sess.updated')}</th><th style="width:50px"></th></tr></thead>
            <tbody>
              ${sessions.map(s => html`
                <tr id="sess-${s.chat_id}">
                  <td><small>${s.chat_id}</small></td>
                  <td><code style="font-size:0.75rem">${s.session_id}</code></td>
                  <td class="ts-cell">${formatTs(s.updated_at)}</td>
                  <td><button hx-delete="/bot/${name}/sessions/${s.chat_id}" hx-target="#sess-${s.chat_id}" hx-swap="outerHTML"
                    hx-confirm="${t('sess.clearConfirm')}" class="danger btn-sm"><i data-lucide="trash-2" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button></td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      `
    }

    <!-- Disk Sessions (Claude Code) -->
    <div class="section-header" style="margin-top:1.5rem">
      <h3 style="margin:0"><i data-lucide="hard-drive" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('sess.disk')}</h3>
      <small>${diskSessions.length} ${diskSessions.length === 1 ? 'session' : 'sessions'}</small>
    </div>
    ${diskSessions.length === 0
      ? html`<p style="color:var(--muted);font-size:0.85rem">${t('sess.noDisk')}</p>`
      : html`
        <div class="table-wrap">
          <table>
            <thead><tr><th style="width:90px">ID</th><th>${t('sess.preview')}</th><th style="width:170px">${t('sess.updated')}</th></tr></thead>
            <tbody>
              ${diskSessions.map(s => html`
                <tr>
                  <td><code style="font-size:0.75rem">${s.sessionId.slice(0, 8)}…</code></td>
                  <td style="font-size:0.85rem">${s.preview}</td>
                  <td class="ts-cell">${formatTs(s.updatedAt)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      `
    }
  `
  return c.html(layout(`${name} ${t('botnav.settings')}`, content, `/bot/${name}/settings`, t, lang))
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

app.delete('/bot/:name/sessions/:chatId', validateBot, (c) => {
  deleteSession(botName(c), c.req.param('chatId')!)
  return c.html(html``)
})

export default app
