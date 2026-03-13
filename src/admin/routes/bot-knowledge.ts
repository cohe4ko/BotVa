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
  for (const folder of ['context', 'knowledge']) {
    const d = resolve(botDir, folder)
    if (existsSync(d)) dirs.push(folder)
  }
  // fallback: at least show knowledge even if empty
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
      <h3>${t('know.title')}</h3>
      <table>
        <thead><tr><th>${t('know.name')}</th><th>${t('know.size')}</th><th></th></tr></thead>
        <tbody>
          ${rootFiles.map(f => html`<tr>
            <td><a href="/bot/${name}/knowledge?path=${f.path}">${f.name}/</a></td>
            <td></td>
            <td></td>
          </tr>`)}
        </tbody>
      </table>
    `
    return c.html(layout(`${name} ${t('know.title')}`, content, `/bot/${name}`, t, lang))
  }

  // Sub-level: resolve and list
  const resolved = resolveKnowledgePath(name, subpath)
  if (!resolved) return c.html(layout(`${name} ${t('know.title')}`, html`${botNav(name, 'knowledge', t)}${alert('error', t('know.invalidPath'))}`, `/bot/${name}`, t, lang))

  const files = listFiles(resolved.full, resolved.base)
  const parts = subpath.split('/')
  const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : ''

  const content = html`
    ${botNav(name, 'knowledge', t)}
    <h3>${subpath}/</h3>
    <p><a href="/bot/${name}/knowledge?path=${parentPath}">${t('know.up')}</a></p>
    <table>
      <thead><tr><th>${t('know.name')}</th><th>${t('know.size')}</th><th></th></tr></thead>
      <tbody>
        ${files.map(f => html`<tr>
          <td>${f.isDir ? html`<a href="/bot/${name}/knowledge?path=${f.path}">${f.name}/</a>` : html`<a href="/bot/${name}/knowledge/file?path=${f.path}">${f.name}</a>`}</td>
          <td><small>${f.isDir ? '' : formatSize(f.size)}</small></td>
          <td>${!f.isDir ? html`<a href="/bot/${name}/knowledge/file?path=${f.path}">${t('know.edit')}</a>` : ''}</td>
        </tr>`)}
        ${files.length === 0 ? html`<tr><td colspan="3">${t('know.emptyDir')}</td></tr>` : ''}
      </tbody>
    </table>
  `
  return c.html(layout(`${name} ${t('know.title')}`, content, `/bot/${name}`, t, lang))
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

  const content = html`
    ${botNav(name, 'knowledge', t)}
    <h3>${filePath}</h3>
    <div id="file-alerts"></div>
    <form hx-post="/bot/${name}/knowledge/file?path=${filePath}" hx-target="#file-alerts" hx-swap="innerHTML">
      <textarea name="content" class="code" rows="25" style="width:100%">${fileContent}</textarea>
      <div class="btn-group">
        <button type="submit">${t('common.save')}</button>
        <a href="/bot/${name}/knowledge?path=${filePath.split('/').slice(0, -1).join('/')}" role="button" class="secondary outline">${t('know.back')}</a>
      </div>
    </form>
  `
  return c.html(layout(`${name} ${t('know.title')} — ${filePath}`, content, `/bot/${name}`, t, lang))
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
