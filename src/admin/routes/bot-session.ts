import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { marked } from 'marked'
import { layout, botNav } from '../views/layout.js'
import { formatTs, pagination } from '../views/components.js'
import { validateBot, botName } from '../bot-middleware.js'
import { readFullSession } from '../../disk-sessions.js'
import type { ContentBlock } from '../../disk-sessions.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')

const PAGE_SIZE = 50

function renderMd(text: string): string {
  return marked.parse(text, { async: false }) as string
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function truncateToolInput(input: string, max = 3000): string {
  if (input.length <= max) return input
  return input.slice(0, max) + '\n… (truncated)'
}

function formatTime(timestamp?: string): string {
  if (!timestamp) return ''
  try {
    return new Date(timestamp).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

function renderBlock(block: ContentBlock, t: TFunc) {
  switch (block.kind) {
    case 'text':
      return html`<div class="msg-text doc-content">${raw(renderMd(block.text || ''))}</div>`
    case 'thinking':
      return html`<details class="msg-thinking"><summary>${t('sess.thinking')}</summary><pre>${block.text || ''}</pre></details>`
    case 'tool_use':
      return html`<details class="msg-tool"><summary><code>${block.toolName}</code></summary><pre>${escapeHtml(truncateToolInput(block.toolInput || ''))}</pre></details>`
    case 'tool_result':
      return html`<details class="msg-tool-result"><summary>${t('sess.toolResult')}</summary><pre>${escapeHtml(truncateToolInput(block.text || ''))}</pre></details>`
    default:
      return html``
  }
}

const app = new Hono<I18nEnv>()

app.get('/bot/:name/session/:sessionId', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const sessionId = c.req.param('sessionId')!

  const botDir = resolve(PROJECT_ROOT, 'bots', name)
  const session = readFullSession(botDir, sessionId)

  if (!session) {
    const content = html`
      ${botNav(name, 'settings', t)}
      <div class="breadcrumb">
        <a href="/bot/${name}/settings">${t('sess.back')}</a>
      </div>
      <div class="empty-state">
        <div class="empty-icon"><i data-lucide="file-x" style="width:32px;height:32px"></i></div>
        <p>${t('sess.notFound')}</p>
      </div>
    `
    return c.html(layout(`${t('sess.notFound')} — ${name}`, content, `/bot/${name}/settings`, t, lang), 404)
  }

  const totalMessages = session.messages.length
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const totalPages = Math.max(1, Math.ceil(totalMessages / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const start = (currentPage - 1) * PAGE_SIZE
  const pageMessages = session.messages.slice(start, start + PAGE_SIZE)

  const sessionTitle = session.title || `Session ${sessionId.slice(0, 8)}…`

  const content = html`
    ${botNav(name, 'settings', t)}

    <div class="breadcrumb">
      <a href="/bot/${name}/settings">${t('sess.back')}</a>
      <span class="sep">/</span>
      <span>${sessionTitle}</span>
    </div>

    <div class="session-meta">
      <div class="session-meta-row">
        <span class="session-meta-label">ID</span>
        <code style="font-size:0.78rem">${sessionId}</code>
      </div>
      ${session.title ? html`
        <div class="session-meta-row">
          <span class="session-meta-label">Title</span>
          <span>${session.title}</span>
        </div>
      ` : ''}
      <div class="session-meta-row">
        <span class="session-meta-label">${t('sess.updated')}</span>
        <span>${formatTs(session.updatedAt)}</span>
      </div>
      <div class="session-meta-row">
        <span class="session-meta-label">${t('sess.messages')}</span>
        <span>${totalMessages}</span>
      </div>
    </div>

    <div class="session-messages">
      ${pageMessages.map((msg, i) => html`
        <div class="msg msg-${msg.type}">
          <div class="msg-header">
            <i data-lucide="${msg.type === 'user' ? 'user' : 'bot'}" style="width:14px;height:14px"></i>
            <strong>${msg.type === 'user' ? t('sess.user') : t('sess.assistant')}</strong>
            ${msg.timestamp ? html`<span class="msg-time">${formatTime(msg.timestamp)}</span>` : ''}
            <span class="msg-num">#${start + i + 1}</span>
          </div>
          <div class="msg-body">
            ${msg.blocks.map(block => renderBlock(block, t))}
          </div>
        </div>
      `)}
    </div>

    ${pagination(currentPage, totalPages, `/bot/${name}/session/${sessionId}`)}
  `
  return c.html(layout(`${sessionTitle} — ${name}`, content, `/bot/${name}/settings`, t, lang))
})

export default app
