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
    <div class="section-header">
      <h3 style="margin:0"><i data-lucide="brain" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('mem.title')}</h3>
      <small>${total} ${total === 1 ? 'memory' : 'memories'}</small>
    </div>
    <form method="GET" action="/bot/${name}/memories" class="filter-bar">
      <label class="filter-search">
        <small>${t('mem.search')}</small>
        <input type="search" name="q" value="${q}" placeholder="${t('mem.search')}">
      </label>
      <button type="submit" class="btn-sm"><i data-lucide="search" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('mem.searchBtn')}</button>
      ${q ? html`<a href="/bot/${name}/memories" role="button" class="btn-sm outline" style="text-decoration:none"><i data-lucide="x" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i></a>` : ''}
    </form>
    <div id="mem-alerts"></div>
    ${memories.length === 0
      ? html`<div class="empty-state"><div class="empty-icon"><i data-lucide="brain" style="width:32px;height:32px"></i></div><p>${t('mem.noMemories')}</p></div>`
      : html`
        <div class="table-wrap">
          <table>
            <thead><tr><th>${t('mem.content')}</th><th style="width:130px">${t('mem.salience')}</th><th style="width:100px">${t('mem.created')}</th><th style="width:40px"></th></tr></thead>
            <tbody>
              ${memories.map(m => html`
                <tr id="mem-${m.id}">
                  <td title="${m.content}" style="font-size:0.78rem">${truncate(m.content, 100)}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:0.3rem">
                      <span class="salience-bar" style="width:${Math.round(m.salience / 5 * 60)}px"></span>
                      <input type="number" step="0.1" min="0" max="5" value="${m.salience.toFixed(2)}"
                        style="width:4.5rem;padding:0.2rem 0.35rem;font-size:0.78rem"
                        hx-put="/bot/${name}/memories/${m.id}" hx-target="#mem-alerts" hx-swap="innerHTML"
                        hx-include="this" name="salience">
                    </div>
                  </td>
                  <td class="ts-cell">${formatTs(m.created_at)}</td>
                  <td><button hx-post="/bot/${name}/memories/${m.id}/delete" hx-target="#mem-${m.id}" hx-swap="outerHTML"
                    hx-confirm="${t('mem.deleteConfirm')}" class="danger btn-sm"><i data-lucide="trash-2" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></button></td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
        ${pagination(page, totalPages, baseUrl)}
      `
    }
  `
  return c.html(layout(`${name} ${t('mem.title')}`, content, `/bot/${name}/memories`, t, lang))
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
