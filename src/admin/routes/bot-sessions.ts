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
    <h3>${t('sess.title')} <small>(${sessions.length})</small></h3>
    <table>
      <thead><tr><th>${t('sess.chatId')}</th><th>${t('sess.sessionId')}</th><th>${t('sess.updated')}</th><th></th></tr></thead>
      <tbody>
        ${sessions.map(s => html`
          <tr id="sess-${s.chat_id}">
            <td>${s.chat_id}</td>
            <td><small>${s.session_id}</small></td>
            <td>${formatTs(s.updated_at)}</td>
            <td><button hx-delete="/bot/${name}/sessions/${s.chat_id}" hx-target="#sess-${s.chat_id}" hx-swap="outerHTML"
              hx-confirm="${t('sess.clearConfirm')}" class="secondary outline" style="padding:0.2rem 0.5rem;font-size:0.8rem">${t('sess.clear')}</button></td>
          </tr>
        `)}
        ${sessions.length === 0 ? html`<tr><td colspan="4">${t('sess.noSessions')}</td></tr>` : ''}
      </tbody>
    </table>
  `
  return c.html(layout(`${name} ${t('sess.title')}`, content, `/bot/${name}`, t, lang))
})

app.delete('/bot/:name/sessions/:chatId', validateBot, (c) => {
  deleteSession(botName(c), c.req.param('chatId')!)
  return c.html(html``)
})

export default app
