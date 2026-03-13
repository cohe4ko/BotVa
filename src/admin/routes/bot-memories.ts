import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav } from '../views/layout.js'
import { alert, formatTs, truncate, pagination } from '../views/components.js'
import { getMemories, countMemories, updateMemorySalience, deleteMemory } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()
const PAGE_SIZE = 30

app.get('/bot/:name/memories', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const q = c.req.query('q') || ''
  const page = parseInt(c.req.query('page') || '1', 10)
  const offset = (page - 1) * PAGE_SIZE

  let total = 0
  let memories: ReturnType<typeof getMemories> = []
  try {
    total = countMemories(name, q || undefined)
    memories = getMemories(name, PAGE_SIZE, offset, q || undefined)
  } catch { /* db may not exist */ }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const baseUrl = `/bot/${name}/memories${q ? `?q=${encodeURIComponent(q)}` : ''}`

  const content = html`
    ${botNav(name, 'memories', t)}
    <h3>${t('mem.title')} <small>(${total})</small></h3>
    <form method="GET" action="/bot/${name}/memories" role="search">
      <input type="search" name="q" value="${q}" placeholder="${t('mem.search')}">
      <button type="submit">${t('mem.searchBtn')}</button>
    </form>
    <div id="mem-alerts"></div>
    <table>
      <thead><tr><th>${t('mem.id')}</th><th>${t('mem.sector')}</th><th>${t('mem.content')}</th><th>${t('mem.salience')}</th><th>${t('mem.created')}</th><th></th></tr></thead>
      <tbody>
        ${memories.map(m => html`
          <tr id="mem-${m.id}">
            <td>${m.id}</td>
            <td><small>${m.sector}</small></td>
            <td title="${m.content}">${truncate(m.content, 100)}</td>
            <td>
              <div style="display:flex;align-items:center;gap:0.3rem">
                <span class="salience-bar" style="width:${Math.round(m.salience / 5 * 60)}px"></span>
                <input type="number" step="0.1" min="0" max="5" value="${m.salience.toFixed(2)}"
                  style="width:5rem;padding:0.2rem;font-size:0.8rem"
                  hx-put="/bot/${name}/memories/${m.id}" hx-target="#mem-alerts" hx-swap="innerHTML"
                  hx-include="this" name="salience">
              </div>
            </td>
            <td><small>${formatTs(m.created_at)}</small></td>
            <td><button hx-post="/bot/${name}/memories/${m.id}/delete" hx-target="#mem-${m.id}" hx-swap="outerHTML"
              hx-confirm="${t('mem.deleteConfirm')}" class="secondary outline" style="padding:0.2rem 0.5rem;font-size:0.8rem">${t('mem.del')}</button></td>
          </tr>
        `)}
        ${memories.length === 0 ? html`<tr><td colspan="6">${t('mem.noMemories')}</td></tr>` : ''}
      </tbody>
    </table>
    ${pagination(page, totalPages, baseUrl)}
  `
  return c.html(layout(`${name} ${t('mem.title')}`, content, `/bot/${name}`, t, lang))
})

app.put('/bot/:name/memories/:id', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const id = parseInt(c.req.param('id')!, 10)
  const body = await c.req.parseBody()
  const salience = parseFloat(String(body['salience'] ?? '1'))
  if (isNaN(salience) || salience < 0 || salience > 5) return c.html(alert('error', t('mem.salienceRange')))
  updateMemorySalience(name, id, salience)
  return c.html(alert('success', t('mem.salienceUpdated', { id: String(id), value: salience.toFixed(2) })))
})

app.delete('/bot/:name/memories/:id', validateBot, (c) => {
  deleteMemory(botName(c), parseInt(c.req.param('id')!, 10))
  return c.html(html``)
})

app.post('/bot/:name/memories/:id/delete', validateBot, (c) => {
  try {
    deleteMemory(botName(c), parseInt(c.req.param('id')!, 10))
  } catch (err) {
    console.error(err)
  }
  return c.html(html``)
})

export default app
