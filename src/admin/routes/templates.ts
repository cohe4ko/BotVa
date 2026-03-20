import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { alert } from '../views/components.js'
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import { getRolesDir, getAvailableRoles } from '../../bot-manager.js'

const SLUG_RE = /^[a-z][a-z0-9-]*$/

function validateSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes('..')
}

function getHistoryDir(slug: string): string {
  return resolve(getRolesDir(), '.history', slug)
}

function getHistoryVersions(slug: string): string[] {
  const dir = getHistoryDir(slug)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()
}

function saveToHistory(slug: string): void {
  const rolesDir = getRolesDir()
  const filePath = resolve(rolesDir, `${slug}.md`)
  if (!existsSync(filePath)) return

  const current = readFileSync(filePath, 'utf-8')
  if (!current.trim()) return

  const histDir = getHistoryDir(slug)
  mkdirSync(histDir, { recursive: true })

  // Check if content differs from last version
  const versions = getHistoryVersions(slug)
  if (versions.length > 0) {
    const lastContent = readFileSync(resolve(histDir, versions[0]), 'utf-8')
    if (lastContent === current) return // no change
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  writeFileSync(resolve(histDir, `${ts}.md`), current)
}

function formatTimestamp(filename: string): string {
  // 2026-03-14T10-30-00.md -> 2026-03-14 10:30:00
  return filename.replace('.md', '').replace('T', ' ').replace(/-(\d{2})-(\d{2})$/, ':$1:$2')
}

const app = new Hono<I18nEnv>()

// --- Template list page ---
app.get('/templates', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const rolesDir = getRolesDir()
  const roles = getAvailableRoles()
  const baseFiles = ['_soul.md', '_tools.md'].filter(f => existsSync(resolve(rolesDir, f)))
  const baseDescriptions: Record<string, string> = {
    '_soul': 'Soul, rules, format, workspace files',
    '_tools': 'Generic tool routing, SaveFact, AskUser',
  }

  const content = html`
    <h2>${icon('file-code')} ${t('tpl.title')}</h2>
    <div id="tpl-alerts"></div>

    ${baseFiles.length > 0 ? html`
      ${baseFiles.map(f => {
        const slug = f.replace('.md', '')
        return html`
        <div class="form-section" style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem 1rem">
          <div>
            <strong>${f}</strong> <small style="opacity:0.7">${baseDescriptions[slug] ?? t('tpl.base')}</small>
          </div>
          <button hx-get="/templates/${slug}/edit" hx-target="#template-editor" hx-swap="innerHTML" class="outline" style="margin:0;padding:0.25rem 0.75rem">
            ${icon('pencil', 13)} ${t('tpl.edit')}
          </button>
        </div>`
      })}
    ` : ''}

    <table>
      <thead>
        <tr>
          <th>${t('tpl.template')}</th>
          <th>${t('tpl.description')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${roles.map(r => html`
          <tr>
            <td><strong>${r.slug}</strong></td>
            <td>${r.description}</td>
            <td>
              <button hx-get="/templates/${r.slug}/edit" hx-target="#template-editor" hx-swap="innerHTML" class="outline" style="margin:0;padding:0.25rem 0.75rem">
                ${icon('pencil', 13)} ${t('tpl.edit')}
              </button>
            </td>
          </tr>
        `)}
      </tbody>
    </table>

    <details style="margin-top:1rem">
      <summary>${icon('plus', 13)} ${t('tpl.create')}</summary>
      <form hx-post="/templates/create" hx-target="#tpl-alerts" hx-swap="innerHTML" style="margin-top:0.5rem">
        <div class="grid">
          <label>${t('tpl.slugLabel')}
            <input type="text" name="slug" required pattern="[a-z][a-z0-9-]*" placeholder="my-role">
          </label>
        </div>
        <label>${t('tpl.contentLabel')}
          <textarea name="content" class="code" rows="10" required placeholder="# {{BOT_NAME}} {{BOT_EMOJI}}"></textarea>
        </label>
        <button type="submit">${icon('plus', 13)} ${t('tpl.create')}</button>
      </form>
    </details>

    <div id="template-editor" style="margin-top:1.5rem"></div>
    <div id="template-history" style="margin-top:1rem"></div>
  `

  return c.html(layout(t('tpl.title'), content, '/templates', t, lang))
})

// --- Inline editor fragment ---
app.get('/templates/:slug/edit', (c) => {
  const t: TFunc = c.get('t')
  const slug = c.req.param('slug')

  // Allow _soul, _tools as base files
  const isBaseFile = slug.startsWith('_') && /^_[a-z]+$/.test(slug)
  const safeSlug = isBaseFile ? slug : slug
  if (!isBaseFile && !validateSlug(safeSlug)) {
    return c.html(alert('error', t('tpl.slugInvalid')))
  }

  const rolesDir = getRolesDir()
  const filePath = resolve(rolesDir, `${safeSlug}.md`)

  if (!existsSync(filePath)) {
    return c.html(alert('error', t('tpl.contentEmpty')))
  }

  const content = readFileSync(filePath, 'utf-8')
  const historyCount = getHistoryVersions(safeSlug).length
  return c.html(html`
    <h3 class="section-title">${icon('file-pen')} ${t('tpl.editing', { slug: safeSlug + '.md' })}</h3>
    <form hx-post="/templates/${safeSlug}" hx-target="#tpl-alerts" hx-swap="innerHTML">
      <textarea name="content" class="code" rows="25">${content}</textarea>
      <div class="btn-group" style="margin-top:0.5rem">
        <button type="submit">${icon('save', 13)} ${t('tpl.save')}</button>
        <button type="button" hx-get="/templates/${safeSlug}/history" hx-target="#template-history" hx-swap="innerHTML" class="outline">
          ${icon('history', 13)} ${t('tpl.history')} ${historyCount > 0 ? `(${historyCount})` : ''}
        </button>
        ${!isBaseFile ? html`
          <button type="button" hx-post="/templates/${safeSlug}/delete" hx-target="#tpl-alerts" hx-swap="innerHTML"
            hx-confirm="${t('tpl.deleteConfirm', { slug: safeSlug })}" class="outline danger" style="margin-left:auto">
            ${icon('trash-2', 13)} ${t('tpl.delete')}
          </button>
        ` : ''}
      </div>
    </form>
  `)
})

// --- Save template ---
app.post('/templates/:slug', async (c) => {
  const t: TFunc = c.get('t')
  const slug = c.req.param('slug')

  const isBaseFile = slug.startsWith('_') && /^_[a-z]+$/.test(slug)
  const safeSlug = slug
  if (safeSlug !== '_base' && !validateSlug(safeSlug)) {
    return c.html(alert('error', t('tpl.slugInvalid')))
  }

  const body = await c.req.parseBody()
  const content = String(body['content'] ?? '').replace(/\r\n/g, '\n')

  if (!content.trim()) {
    return c.html(alert('error', t('tpl.contentEmpty')))
  }

  const rolesDir = getRolesDir()
  const filePath = resolve(rolesDir, `${safeSlug}.md`)

  // Save current version to history before overwriting
  saveToHistory(safeSlug)

  writeFileSync(filePath, content)
  return c.html(alert('success', t('tpl.saved', { slug: safeSlug })))
})

// --- Create new template ---
app.post('/templates/create', async (c) => {
  const t: TFunc = c.get('t')
  const body = await c.req.parseBody()
  const slug = String(body['slug'] ?? '').toLowerCase().trim()
  const content = String(body['content'] ?? '').replace(/\r\n/g, '\n')

  if (!validateSlug(slug)) {
    return c.html(alert('error', t('tpl.slugInvalid')))
  }
  if (!content.trim()) {
    return c.html(alert('error', t('tpl.contentEmpty')))
  }

  const rolesDir = getRolesDir()
  const filePath = resolve(rolesDir, `${slug}.md`)

  if (existsSync(filePath)) {
    return c.html(alert('error', t('tpl.slugExists', { slug })))
  }

  writeFileSync(filePath, content)
  return c.html(html`
    ${alert('success', t('tpl.created', { slug }))}
    <script>setTimeout(function(){ location.reload(); }, 800);</script>
  `)
})

// --- Delete template ---
app.post('/templates/:slug/delete', async (c) => {
  const t: TFunc = c.get('t')
  const slug = c.req.param('slug')

  if (slug.startsWith('_')) {
    return c.html(alert('error', t('tpl.cantDeleteBase')))
  }
  if (!validateSlug(slug)) {
    return c.html(alert('error', t('tpl.slugInvalid')))
  }

  const rolesDir = getRolesDir()
  const filePath = resolve(rolesDir, `${slug}.md`)

  if (!existsSync(filePath)) {
    return c.html(alert('error', t('tpl.contentEmpty')))
  }

  // Save to history before deleting
  saveToHistory(slug)
  unlinkSync(filePath)

  return c.html(html`
    ${alert('success', t('tpl.deleted', { slug }))}
    <script>setTimeout(function(){ location.reload(); }, 800);</script>
  `)
})

// --- History list ---
app.get('/templates/:slug/history', (c) => {
  const t: TFunc = c.get('t')
  const slug = c.req.param('slug')
  const isBaseFile = slug.startsWith('_') && /^_[a-z]+$/.test(slug)
  const safeSlug = slug
  if (safeSlug !== '_base' && !validateSlug(safeSlug)) {
    return c.html(alert('error', t('tpl.slugInvalid')))
  }

  const versions = getHistoryVersions(safeSlug)

  if (versions.length === 0) {
    return c.html(html`<p style="opacity:0.6">${t('tpl.noHistory')}</p>`)
  }

  return c.html(html`
    <h4>${icon('history', 14)} ${t('tpl.historyTitle', { slug: safeSlug })}</h4>
    <table>
      <tbody>
        ${versions.map(v => html`
          <tr>
            <td>${formatTimestamp(v)}</td>
            <td style="text-align:right">
              <button hx-get="/templates/${safeSlug}/history/${v.replace('.md', '')}" hx-target="#template-history-preview" hx-swap="innerHTML" class="outline" style="margin:0;padding:0.2rem 0.5rem">
                ${icon('eye', 12)} ${t('tpl.view')}
              </button>
              <button hx-post="/templates/${safeSlug}/history/${v.replace('.md', '')}/restore" hx-target="#tpl-alerts" hx-swap="innerHTML"
                hx-confirm="${t('tpl.restoreConfirm')}" class="outline" style="margin:0;padding:0.2rem 0.5rem">
                ${icon('undo-2', 12)} ${t('tpl.restore')}
              </button>
            </td>
          </tr>
        `)}
      </tbody>
    </table>
    <div id="template-history-preview" style="margin-top:0.5rem"></div>
  `)
})

// --- View history version ---
app.get('/templates/:slug/history/:ts', (c) => {
  const t: TFunc = c.get('t')
  const slug = c.req.param('slug')
  const ts = c.req.param('ts')
  const isBaseFile = slug.startsWith('_') && /^_[a-z]+$/.test(slug)
  const safeSlug = slug

  const histDir = getHistoryDir(safeSlug)
  const filePath = resolve(histDir, `${ts}.md`)

  if (!existsSync(filePath)) {
    return c.html(alert('error', t('tpl.noHistory')))
  }

  const content = readFileSync(filePath, 'utf-8')

  return c.html(html`
    <details open>
      <summary>${t('tpl.versionDate', { date: formatTimestamp(ts + '.md') })}</summary>
      <pre style="max-height:400px;overflow:auto;font-size:0.82rem;white-space:pre-wrap;background:var(--mc-surface2);padding:0.75rem;border-radius:var(--radius-sm)">${content}</pre>
    </details>
  `)
})

// --- Restore history version ---
app.post('/templates/:slug/history/:ts/restore', async (c) => {
  const t: TFunc = c.get('t')
  const slug = c.req.param('slug')
  const ts = c.req.param('ts')
  const isBaseFile = slug.startsWith('_') && /^_[a-z]+$/.test(slug)
  const safeSlug = slug

  if (safeSlug !== '_base' && !validateSlug(safeSlug)) {
    return c.html(alert('error', t('tpl.slugInvalid')))
  }

  const histDir = getHistoryDir(safeSlug)
  const versionPath = resolve(histDir, `${ts}.md`)

  if (!existsSync(versionPath)) {
    return c.html(alert('error', t('tpl.noHistory')))
  }

  const rolesDir = getRolesDir()
  const filePath = resolve(rolesDir, `${safeSlug}.md`)

  // Save current to history before restoring
  saveToHistory(safeSlug)

  const restored = readFileSync(versionPath, 'utf-8')
  writeFileSync(filePath, restored)

  return c.html(html`
    ${alert('success', t('tpl.restored', { slug: safeSlug }))}
    <script>setTimeout(function(){ document.querySelector('[hx-get="/templates/${safeSlug}/edit"]')?.click(); }, 500);</script>
  `)
})

export default app
