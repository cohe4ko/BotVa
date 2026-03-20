import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { TFunc } from '../i18n.js'

export function alert(type: 'success' | 'error' | 'warning', message: string): HtmlEscapedString {
  const icons = { success: 'check-circle', error: 'x-circle', warning: 'alert-triangle' }
  return html`<div class="alert alert-${type}"><i data-lucide="${icons[type]}" style="width:15px;height:15px;flex-shrink:0"></i> ${message}</div>` as HtmlEscapedString
}

export function statusBadge(running: boolean, t?: TFunc): HtmlEscapedString {
  const _t = t ?? ((k: string) => k)
  return running
    ? html`<span class="badge badge-running"><i data-lucide="circle" style="width:8px;height:8px;fill:currentColor"></i> ${_t('status.running')}</span>` as HtmlEscapedString
    : html`<span class="badge badge-stopped"><i data-lucide="circle" style="width:8px;height:8px;fill:currentColor"></i> ${_t('status.stopped')}</span>` as HtmlEscapedString
}

export function taskStatusBadge(status: string): HtmlEscapedString {
  return html`<span class="badge badge-${status}">${status}</span>` as HtmlEscapedString
}

export function formatTs(ts: number): string {
  if (!ts) return '\u2014'
  return new Date(ts * 1000).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}

/** Collapsible guide/help block. items = array of plain text lines rendered as <li> */
export function guideBlock(title: string, items: string[]): HtmlEscapedString {
  return html`
    <details style="margin-bottom:1.5rem;border:1px solid var(--mc-border);border-radius:8px;padding:0.75rem 1rem;background:var(--mc-bg-dim, #f8f9fa)">
      <summary style="cursor:pointer;font-weight:600;display:flex;align-items:center;gap:0.5rem">
        <i data-lucide="help-circle" style="width:16px;height:16px"></i> ${title}
      </summary>
      <ul style="margin-top:0.75rem;padding-left:1.25rem;font-size:0.88rem;line-height:1.65">
        ${items.map(item => html`<li style="margin-bottom:0.3rem">${item}</li>`)}
      </ul>
    </details>
  ` as HtmlEscapedString
}

export function truncate(s: string, max = 80): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\u2026'
}

export function pagination(currentPage: number, totalPages: number, baseUrl: string): HtmlEscapedString {
  if (totalPages <= 1) return html`` as HtmlEscapedString

  const WINDOW = 2
  const pages: (number | '...')[] = []

  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= currentPage - WINDOW && i <= currentPage + WINDOW)) {
      pages.push(i)
    } else if (pages[pages.length - 1] !== '...') {
      pages.push('...')
    }
  }

  const sep = baseUrl.includes('?') ? '&' : '?'
  return html`
    <nav>
      <ul>
        ${pages.map(p => p === '...'
          ? html`<li><span style="padding:0.3rem 0.2rem;color:var(--mc-text-dim)">…</span></li>`
          : html`<li><a href="${baseUrl}${sep}page=${p}" ${p === currentPage ? 'aria-current="page"' : ''}>${p}</a></li>`
        )}
      </ul>
    </nav>
  ` as HtmlEscapedString
}
