import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { formatTs, pagination } from '../views/components.js'
import { getAuditLogs, countAuditLogs, getAuditEventTypes } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'

const app = new Hono()
const PER_PAGE = 50

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const EVENT_ICONS: Record<string, string> = {
  tool_call: 'wrench',
  command: 'terminal',
  error: 'alert-triangle',
  session_start: 'log-in',
  session_clear: 'trash-2',
}

function eventBadge(type: string) {
  const iconName = EVENT_ICONS[type] ?? 'circle'
  return html`<span class="badge-event badge-event-${type}"><i data-lucide="${iconName}" style="width:11px;height:11px"></i> ${type}</span>`
}

app.get('/bot/:name/audit', validateBot, (c) => {
  const name = botName(c)
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const eventType = c.req.query('type') ?? ''
  const search = c.req.query('q') ?? ''

  const total = countAuditLogs(name, eventType || undefined, search || undefined)
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))
  const offset = (page - 1) * PER_PAGE
  const logs = getAuditLogs(name, PER_PAGE, offset, eventType || undefined, search || undefined)
  const eventTypes = getAuditEventTypes(name)

  const baseUrl = `/bot/${name}/audit?${eventType ? `type=${eventType}&` : ''}${search ? `q=${encodeURIComponent(search)}&` : ''}`

  const content = html`
    ${botNav(name, 'audit')}

    <div class="section-header">
      <h3>${icon('scroll-text')} Audit Log</h3>
      <small>${total} events</small>
    </div>

    <form method="GET" action="/bot/${name}/audit" class="filter-bar">
      <label>
        <small>Type</small>
        <select name="type" style="min-width:140px">
          <option value="">All types</option>
          ${eventTypes.map(t => html`<option value="${t}" ${t === eventType ? 'selected' : ''}>${t}</option>`)}
        </select>
      </label>
      <label class="filter-search">
        <small>Search</small>
        <input type="text" name="q" value="${search}" placeholder="Search in detail...">
      </label>
      <button type="submit" class="btn-sm">${icon('search', 13)} Filter</button>
      ${(eventType || search) ? html`<a href="/bot/${name}/audit" role="button" class="btn-sm" style="text-decoration:none">${icon('x', 13)} Clear</a>` : ''}
    </form>

    ${logs.length === 0
      ? html`<div class="empty-state"><div class="empty-icon">${icon('scroll-text', 32)}</div><p>No audit events found</p></div>`
      : html`
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:170px">Time</th>
                <th style="width:140px">Type</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              ${logs.map(row => html`
                <tr>
                  <td class="ts-cell">${formatTs(row.created_at)}</td>
                  <td>${eventBadge(row.event_type)}</td>
                  <td class="detail-cell">${row.detail ? escapeHtml(row.detail) : '\u2014'}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
        ${pagination(page, totalPages, baseUrl)}
      `
    }
  `

  return c.html(layout(`${name} Audit`, content, `/bot/${name}`))
})

export default app
