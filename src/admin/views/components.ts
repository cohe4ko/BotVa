import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

export function alert(type: 'success' | 'error' | 'warning', message: string): HtmlEscapedString {
  const icons = { success: 'check-circle', error: 'x-circle', warning: 'alert-triangle' }
  return html`<div class="alert alert-${type}"><i data-lucide="${icons[type]}" style="width:15px;height:15px;flex-shrink:0"></i> ${message}</div>` as HtmlEscapedString
}

export function statusBadge(running: boolean): HtmlEscapedString {
  return running
    ? html`<span class="badge badge-running"><i data-lucide="circle" style="width:8px;height:8px;fill:currentColor"></i> running</span>` as HtmlEscapedString
    : html`<span class="badge badge-stopped"><i data-lucide="circle" style="width:8px;height:8px;fill:currentColor"></i> stopped</span>` as HtmlEscapedString
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

export function truncate(s: string, max = 80): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\u2026'
}

export function pagination(currentPage: number, totalPages: number, baseUrl: string): HtmlEscapedString {
  if (totalPages <= 1) return html`` as HtmlEscapedString
  const pages = []
  for (let i = 1; i <= totalPages; i++) {
    pages.push(i)
  }
  return html`
    <nav>
      <ul>
        ${pages.map(p => html`
          <li><a href="${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${p}" ${p === currentPage ? 'aria-current="page"' : ''}>${p}</a></li>
        `)}
      </ul>
    </nav>
  ` as HtmlEscapedString
}
