import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav } from '../views/layout.js'
import { formatTs, pagination } from '../views/components.js'
import { getSessions, deleteSession } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import { listDiskSessions, getSessionStats } from '../../disk-sessions.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')

const DISK_PAGE_SIZE = 20

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const app = new Hono<I18nEnv>()

app.get('/bot/:name/sessions', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  let sessions: ReturnType<typeof getSessions> = []
  try { sessions = getSessions(name) } catch { /* db may not exist */ }

  const botDir = resolve(PROJECT_ROOT, 'bots', name)
  const diskSessions = listDiskSessions(botDir)

  // Disk sessions pagination
  const diskPage = Math.max(1, parseInt(String(c.req.query('dp') || '1'), 10))
  const totalDiskPages = Math.max(1, Math.ceil(diskSessions.length / DISK_PAGE_SIZE))
  const curDiskPage = Math.min(diskPage, totalDiskPages)
  const diskStart = (curDiskPage - 1) * DISK_PAGE_SIZE
  const pageSessions = diskSessions.slice(diskStart, diskStart + DISK_PAGE_SIZE)
  const totalSize = diskSessions.reduce((sum, s) => sum + s.fileSize, 0)

  const content = html`
    ${botNav(name, 'sessions', t)}

    <!-- Disk Sessions (Claude Code) -->
    <div class="section-header">
      <h3 style="margin:0"><i data-lucide="hard-drive" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('sess.disk')}</h3>
      <small>${diskSessions.length} ${diskSessions.length === 1 ? 'session' : 'sessions'} · ${formatSize(totalSize)}</small>
    </div>
    ${diskSessions.length === 0
      ? html`<p style="color:var(--muted);font-size:0.85rem">${t('sess.noDisk')}</p>`
      : html`
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="width:90px">ID</th>
              <th>${t('sess.preview')}</th>
              <th style="width:70px">${t('sess.size')}</th>
              <th style="width:110px">${t('sess.stats')}</th>
              <th style="width:150px">${t('sess.updated')}</th>
            </tr></thead>
            <tbody>
              ${pageSessions.map(s => html`
                <tr class="clickable-row" onclick="location.href='/bot/${name}/session/${s.sessionId}'">
                  <td><a href="/bot/${name}/session/${s.sessionId}" onclick="event.stopPropagation()" style="text-decoration:none"><code style="font-size:0.75rem">${s.sessionId.slice(0, 8)}…</code></a></td>
                  <td style="font-size:0.85rem">${s.title || s.preview}</td>
                  <td style="font-size:0.78rem;white-space:nowrap">${formatSize(s.fileSize)}</td>
                  <td style="font-size:0.78rem;white-space:nowrap"
                      hx-get="/bot/${name}/session-stats/${s.sessionId}"
                      hx-trigger="revealed"
                      hx-swap="innerHTML"><small style="color:var(--mc-text-dim)">…</small></td>
                  <td class="ts-cell">${formatTs(s.updatedAt)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
        ${pagination(curDiskPage, totalDiskPages, `/bot/${name}/sessions`)}
      `
    }

    <!-- Active Session (SQLite) -->
    <div class="section-header" style="margin-top:2rem">
      <h3 style="margin:0"><i data-lucide="link" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('sess.active')}</h3>
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
  `
  return c.html(layout(`${name} ${t('sess.title')}`, content, `/bot/${name}/sessions`, t, lang))
})

/** HTMX: lazy-load session stats (messages + tokens) */
app.get('/bot/:name/session-stats/:sessionId', validateBot, (c) => {
  const name = botName(c)
  const sessionId = c.req.param('sessionId')!
  const botDir = resolve(PROJECT_ROOT, 'bots', name)
  const stats = getSessionStats(botDir, sessionId)
  if (!stats) return c.html(html`<small>—</small>`)
  const totalTokens = stats.inputTokens + stats.outputTokens
  const tokensStr = totalTokens >= 1_000_000
    ? `${(totalTokens / 1_000_000).toFixed(1)}M`
    : totalTokens >= 1_000
      ? `${(totalTokens / 1_000).toFixed(0)}K`
      : String(totalTokens)
  return c.html(html`<small>${stats.messages} msg · ${tokensStr} tok</small>`)
})

app.delete('/bot/:name/sessions/:chatId', validateBot, (c) => {
  deleteSession(botName(c), c.req.param('chatId')!)
  return c.html(html``)
})

export default app
