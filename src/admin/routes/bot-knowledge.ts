import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav } from '../views/layout.js'
import { alert } from '../views/components.js'
import { getBotDir } from '../db-multi.js'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import { resolve, relative, join } from 'path'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

function listFiles(dir: string, base: string) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const full = join(dir, e.name)
      const stat = statSync(full)
      return { path: relative(base, full), name: e.name, isDir: e.isDirectory(), size: stat.size }
    })
    .sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name))
}

/** Returns the allowed root dirs for a bot's knowledge section */
function getKnowledgeDirs(name: string): string[] {
  const botDir = getBotDir(name)
  const dirs: string[] = []
  const d = resolve(botDir, 'knowledge')
  if (existsSync(d)) dirs.push('knowledge')
  if (dirs.length === 0) dirs.push('knowledge')
  return dirs
}

/** Resolve a subpath like "knowledge/site-config.md" to an absolute path, validating it stays within bot dir */
function resolveKnowledgePath(name: string, subpath: string): { full: string; base: string } | null {
  const botDir = getBotDir(name)
  const allowed = getKnowledgeDirs(name)
  const topFolder = subpath.split('/')[0]
  if (!topFolder || !allowed.includes(topFolder)) return null
  const base = resolve(botDir)
  const full = resolve(base, subpath)
  if (!full.startsWith(base)) return null
  return { full, base }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

app.get('/bot/:name/knowledge', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const subpath = c.req.query('path') || ''
  const botDir = getBotDir(name)
  const dirs = getKnowledgeDirs(name)

  // Root level: show available folders (context, knowledge)
  if (!subpath) {
    const rootFiles = dirs.map(folder => {
      const d = resolve(botDir, folder)
      const stat = existsSync(d) ? statSync(d) : null
      return { path: folder, name: folder, isDir: true, size: stat?.size ?? 0 }
    })

    const content = html`
      ${botNav(name, 'knowledge', t)}
      <h3 class="section-title"><i data-lucide="book-open" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('know.title')}</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>${t('know.name')}</th><th>${t('know.size')}</th><th style="width:60px"></th></tr></thead>
          <tbody>
            ${rootFiles.map(f => html`<tr>
              <td><a href="/bot/${name}/knowledge?path=${f.path}" style="display:inline-flex;align-items:center;gap:0.35rem"><i data-lucide="folder" style="width:14px;height:14px;display:inline-block;vertical-align:middle;color:var(--mc-yellow)"></i> ${f.name}/</a></td>
              <td></td>
              <td></td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    `
    return c.html(layout(`${name} ${t('know.title')}`, content, `/bot/${name}/knowledge`, t, lang))
  }

  // Sub-level: resolve and list
  const resolved = resolveKnowledgePath(name, subpath)
  if (!resolved) return c.html(layout(`${name} ${t('know.title')}`, html`${botNav(name, 'knowledge', t)}${alert('error', t('know.invalidPath'))}`, `/bot/${name}`, t, lang))

  const files = listFiles(resolved.full, resolved.base)
  const parts = subpath.split('/')
  const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : ''

  const content = html`
    ${botNav(name, 'knowledge', t)}
    <div class="breadcrumb">
      <a href="/bot/${name}/knowledge"><i data-lucide="book-open" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('know.title')}</a>
      ${parts.map((part, i) => html`
        <span class="sep">/</span>
        ${i < parts.length - 1
          ? html`<a href="/bot/${name}/knowledge?path=${parts.slice(0, i + 1).join('/')}">${part}</a>`
          : html`<span style="color:var(--mc-text);font-weight:500">${part}</span>`
        }
      `)}
    </div>
    ${files.length === 0
      ? html`<div class="empty-state"><div class="empty-icon"><i data-lucide="folder-open" style="width:32px;height:32px"></i></div><p>${t('know.emptyDir')}</p></div>`
      : html`
        <div class="table-wrap">
          <table>
            <thead><tr><th>${t('know.name')}</th><th style="width:80px">${t('know.size')}</th><th style="width:60px"></th></tr></thead>
            <tbody>
              ${files.map(f => html`<tr>
                <td>${f.isDir
                  ? html`<a href="/bot/${name}/knowledge?path=${f.path}" style="display:inline-flex;align-items:center;gap:0.35rem"><i data-lucide="folder" style="width:14px;height:14px;display:inline-block;vertical-align:middle;color:var(--mc-yellow)"></i> ${f.name}/</a>`
                  : html`<a href="/bot/${name}/knowledge/file?path=${f.path}" style="display:inline-flex;align-items:center;gap:0.35rem"><i data-lucide="file-text" style="width:14px;height:14px;display:inline-block;vertical-align:middle;color:var(--mc-text-dim)"></i> ${f.name}</a>`}</td>
                <td><small>${f.isDir ? '' : formatSize(f.size)}</small></td>
                <td>${!f.isDir ? html`<a href="/bot/${name}/knowledge/file?path=${f.path}" class="btn-sm" role="button" style="text-decoration:none"><i data-lucide="pencil" style="width:12px;height:12px;display:inline-block;vertical-align:middle"></i></a>` : ''}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>
      `
    }
  `
  return c.html(layout(`${name} ${t('know.title')}`, content, `/bot/${name}/knowledge`, t, lang))
})

app.get('/bot/:name/knowledge/file', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const filePath = c.req.query('path') || ''
  const resolved = resolveKnowledgePath(name, filePath)
  if (!resolved) return c.html(layout(`${name} ${t('know.title')}`, html`${botNav(name, 'knowledge', t)}${alert('error', t('know.invalidPath'))}`, `/bot/${name}`, t, lang))

  let fileContent = ''
  try { fileContent = readFileSync(resolved.full, 'utf-8') } catch { /* new file */ }

  const fileParts = filePath.split('/')
  const content = html`
    ${botNav(name, 'knowledge', t)}
    <div class="breadcrumb">
      <a href="/bot/${name}/knowledge"><i data-lucide="book-open" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('know.title')}</a>
      ${fileParts.map((part, i) => html`
        <span class="sep">/</span>
        ${i < fileParts.length - 1
          ? html`<a href="/bot/${name}/knowledge?path=${fileParts.slice(0, i + 1).join('/')}">${part}</a>`
          : html`<span style="color:var(--mc-text);font-weight:500">${part}</span>`
        }
      `)}
    </div>
    <div id="file-alerts"></div>
    <form class="form-section" hx-post="/bot/${name}/knowledge/file?path=${filePath}" hx-target="#file-alerts" hx-swap="innerHTML">
      <textarea name="content" class="code" rows="25">${fileContent}</textarea>
      <div class="btn-group">
        <button type="submit"><i data-lucide="save" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('common.save')}</button>
        <a href="/bot/${name}/knowledge?path=${fileParts.slice(0, -1).join('/')}" role="button" class="outline" style="text-decoration:none">${t('know.back')}</a>
      </div>
    </form>
  `
  return c.html(layout(`${name} ${t('know.title')} — ${filePath}`, content, `/bot/${name}/knowledge`, t, lang))
})

app.post('/bot/:name/knowledge/file', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const filePath = c.req.query('path') || ''
  const resolved = resolveKnowledgePath(name, filePath)
  if (!resolved) return c.html(alert('error', t('know.invalidPath')))

  const body = await c.req.parseBody()
  writeFileSync(resolved.full, String(body['content'] ?? ''), 'utf-8')
  return c.html(alert('success', t('know.fileSaved')))
})

export default app
