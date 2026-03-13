import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav } from '../views/layout.js'
import { formatTs } from '../views/components.js'
import { getSessions, deleteSession } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

app.get('/bot/:name/sessions', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  let sessions: ReturnType<typeof getSessions> = []
  try { sessions = getSessions(name) } catch { /* db may not exist */ }

  const content = html`
    ${botNav(name, 'sessions', t)}
    <div class="section-header">
      <h3 style="margin:0"><i data-lucide="link" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('sess.title')}</h3>
      <small>${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}</small>
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
  `
  return c.html(layout(`${name} ${t('sess.title')}`, content, `/bot/${name}`, t, lang))
})

app.delete('/bot/:name/sessions/:chatId', validateBot, (c) => {
  deleteSession(botName(c), c.req.param('chatId')!)
  return c.html(html``)
})

export default app
