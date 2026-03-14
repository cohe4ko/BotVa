import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { getBotNames, getProjectRoot } from '../db-multi.js'
import { resolve } from 'path'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import {
  createBackup, restoreBackup, listBackups, deleteBackup,
  verifyBackup, readManifest, formatSize,
} from '../../backup/engine.js'
import { loadScheduleConfig, saveScheduleConfig } from '../../backup/scheduler.js'

const app = new Hono<I18nEnv>()

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// --- Main page ---
app.get('/backup', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const bots = getBotNames()
  const backups = listBackups()
  const schedule = loadScheduleConfig()

  const content = html`
    <h2>${icon('archive', 18)} ${t('bak.title')}</h2>

    <!-- Create Backup -->
    <details open>
      <summary>${icon('plus', 14)} ${t('bak.create')}</summary>
      <form method="POST" action="/backup/create">
        <div class="form-section">
          <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:0.3rem;margin:0">
              <input type="radio" name="type" value="system" checked style="width:auto">
              ${t('bak.createSystem')}
            </label>
            <label style="display:flex;align-items:center;gap:0.3rem;margin:0">
              <input type="radio" name="type" value="bot" style="width:auto">
              ${t('bak.createBot')}
            </label>
            <select name="botName" id="bot-select" style="display:none;width:auto">
              ${bots.map(b => html`<option value="${b}">${b}</option>`)}
            </select>
          </div>
          <div class="btn-group" style="margin-top:0.75rem">
            <button type="submit" class="primary">${icon('download', 14)} ${t('bak.create')}</button>
          </div>
        </div>
      </form>
      <script>
        document.querySelectorAll('input[name="type"]').forEach(r => {
          r.addEventListener('change', () => {
            document.getElementById('bot-select').style.display =
              document.querySelector('input[name="type"][value="bot"]').checked ? 'inline-block' : 'none';
          });
        });
      </script>
    </details>

    <!-- Backup History -->
    <h3 style="margin-top:1.5rem">${icon('history', 16)} ${t('bak.history')}</h3>
    ${backups.length === 0
      ? html`<div class="empty-state"><div class="empty-icon">${icon('archive', 32)}</div><p>${t('bak.noBackups')}</p></div>`
      : html`
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>${t('bak.date')}</th>
                <th class="hide-mobile">${t('bak.type')}</th>
                <th class="hide-mobile">${t('bak.bots')}</th>
                <th>${t('bak.size')}</th>
                <th>${t('bak.actions')}</th>
              </tr>
            </thead>
            <tbody>
              ${backups.map(b => html`
                <tr>
                  <td class="ts-cell">${fmtDate(b.manifest.createdAt)}</td>
                  <td class="hide-mobile"><span class="badge badge-active">${t(`bak.${b.manifest.type}`)}</span></td>
                  <td class="hide-mobile">${b.manifest.bots.join(', ')}</td>
                  <td>${formatSize(b.sizeBytes)}</td>
                  <td>
                    <div class="btn-group">
                      <a href="/backup/download/${b.filename}" class="btn-sm" role="button" title="${t('bak.download')}">${icon('download', 13)}</a>
                      <a href="/backup/manifest/${b.filename}" class="btn-sm" role="button" title="${t('bak.manifest')}">${icon('file-json', 13)}</a>
                      <a href="/backup/verify/${b.filename}" class="btn-sm" role="button" title="${t('bak.verify')}">${icon('shield-check', 13)}</a>
                      <form method="POST" action="/backup/restore/${b.filename}" style="display:inline" onsubmit="return confirm('${t('bak.restoreConfirm', { filename: b.filename })}')">
                        <button type="submit" class="btn-sm contrast outline" title="${t('bak.restore')}">${icon('upload', 13)}</button>
                      </form>
                      <form method="POST" action="/backup/delete/${b.filename}" style="display:inline" onsubmit="return confirm('${t('bak.deleteConfirm', { filename: b.filename })}')">
                        <button type="submit" class="btn-sm secondary outline" title="${t('bak.delete')}">${icon('trash-2', 13)}</button>
                      </form>
                    </div>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      `
    }

    <!-- Schedule -->
    <details style="margin-top:1.5rem">
      <summary>${icon('clock', 14)} ${t('bak.schedule')}</summary>
      <form method="POST" action="/backup/schedule">
        <div class="form-section" style="max-width:500px">
          <label style="display:flex;align-items:center;gap:0.5rem">
            <input type="checkbox" name="enabled" ${schedule?.enabled ? 'checked' : ''} style="width:auto">
            ${t('bak.scheduleEnable')}
          </label>
          <label>
            ${t('bak.scheduleType')}
            <select name="type">
              <option value="system" ${schedule?.type === 'system' || !schedule ? 'selected' : ''}>${t('bak.createSystem')}</option>
              <option value="bot" ${schedule?.type === 'bot' ? 'selected' : ''}>${t('bak.createBot')}</option>
            </select>
          </label>
          <label>
            ${t('bak.selectBot')}
            <select name="botName">
              ${bots.map(b => html`<option value="${b}" ${schedule?.botName === b ? 'selected' : ''}>${b}</option>`)}
            </select>
          </label>
          <label>
            ${t('bak.scheduleCron')}
            <input type="text" name="cron" value="${schedule?.cron ?? '0 3 * * *'}" placeholder="0 3 * * *">
          </label>
          <label>
            ${t('bak.scheduleRetention')}
            <input type="number" name="retentionCount" value="${schedule?.retentionCount ?? 7}" min="1" max="100">
          </label>
          <button type="submit" class="primary" style="margin-top:0.75rem">${t('common.save')}</button>
        </div>
      </form>
    </details>
  `

  return c.html(layout(t('bak.title'), content, '/backup', t, lang))
})

// --- Create backup ---
app.post('/backup/create', async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const body = await c.req.parseBody()
  const type = String(body['type'] ?? 'system') as 'bot' | 'system'
  const botName = type === 'bot' ? String(body['botName'] ?? '') : undefined

  try {
    const info = createBackup({ type, botName })
    const msg = t('bak.created', { filename: info.filename, size: formatSize(info.sizeBytes) })
    const content = html`
      <h2>${icon('archive', 18)} ${t('bak.title')}</h2>
      <div class="alert alert-success">${icon('check', 14)} ${msg}</div>
      <a href="/backup" role="button" class="outline">${icon('arrow-left', 14)} ${t('common.back')}</a>
    `
    return c.html(layout(t('bak.title'), content, '/backup', t, lang))
  } catch (err) {
    const msg = t('bak.failed', { error: err instanceof Error ? err.message : String(err) })
    const content = html`
      <h2>${icon('archive', 18)} ${t('bak.title')}</h2>
      <div class="alert alert-error">${icon('alert-circle', 14)} ${msg}</div>
      <a href="/backup" role="button" class="outline">${icon('arrow-left', 14)} ${t('common.back')}</a>
    `
    return c.html(layout(t('bak.title'), content, '/backup', t, lang))
  }
})

// --- Download ---
app.get('/backup/download/:filename', (c) => {
  const filename = c.req.param('filename')
  if (!filename.startsWith('botva-') || !filename.endsWith('.tar.gz')) {
    return c.text('Invalid filename', 400)
  }

  const root = getProjectRoot()
  const filePath = resolve(root, 'backups', filename)

  try {
    const stat = statSync(filePath)
    const stream = createReadStream(filePath)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(stat.size),
      },
    })
  } catch {
    return c.text('File not found', 404)
  }
})

// --- Verify ---
app.get('/backup/verify/:filename', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const filename = c.req.param('filename')
  const root = getProjectRoot()
  const filePath = resolve(root, 'backups', filename)

  const result = verifyBackup(filePath)
  const alertHtml = result.valid
    ? html`<div class="alert alert-success">${icon('shield-check', 14)} ${t('bak.verified')}</div>`
    : html`<div class="alert alert-error">${icon('alert-circle', 14)} ${t('bak.invalid', { errors: result.errors.join('; ') })}</div>`

  const content = html`
    <h2>${icon('archive', 18)} ${t('bak.title')}</h2>
    ${alertHtml}
    <a href="/backup" role="button" class="outline">${icon('arrow-left', 14)} ${t('common.back')}</a>
  `
  return c.html(layout(t('bak.title'), content, '/backup', t, lang))
})

// --- Manifest ---
app.get('/backup/manifest/:filename', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const filename = c.req.param('filename')
  const root = getProjectRoot()
  const filePath = resolve(root, 'backups', filename)

  try {
    const manifest = readManifest(filePath)
    const content = html`
      <h2>${icon('file-json', 18)} ${t('bak.manifest')}</h2>
      <p style="margin-bottom:1rem"><code>${filename}</code></p>
      <div class="table-wrap">
        <table>
          <tbody>
            <tr><td><strong>${t('bak.type')}</strong></td><td>${manifest.type}</td></tr>
            <tr><td><strong>${t('bak.date')}</strong></td><td>${fmtDate(manifest.createdAt)}</td></tr>
            <tr><td><strong>${t('bak.hostname')}</strong></td><td>${manifest.hostname}</td></tr>
            <tr><td><strong>${t('bak.version')}</strong></td><td>${manifest.botvaVersion}</td></tr>
            <tr><td><strong>${t('bak.bots')}</strong></td><td>${manifest.bots.join(', ')}</td></tr>
            <tr><td><strong>${t('bak.size')}</strong></td><td>${formatSize(manifest.totalSize)}</td></tr>
            <tr><td><strong>Checksum</strong></td><td><code>${manifest.checksum || '—'}</code></td></tr>
          </tbody>
        </table>
      </div>
      <div style="margin-top:1rem">
        <a href="/backup" role="button" class="outline">${icon('arrow-left', 14)} ${t('common.back')}</a>
      </div>
    `
    return c.html(layout(t('bak.manifest'), content, '/backup', t, lang))
  } catch (err) {
    const content = html`
      <h2>${icon('archive', 18)} ${t('bak.title')}</h2>
      <div class="alert alert-error">${icon('alert-circle', 14)} ${String(err)}</div>
      <a href="/backup" role="button" class="outline">${icon('arrow-left', 14)} ${t('common.back')}</a>
    `
    return c.html(layout(t('bak.title'), content, '/backup', t, lang))
  }
})

// --- Restore ---
app.post('/backup/restore/:filename', async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const filename = c.req.param('filename')
  const root = getProjectRoot()
  const filePath = resolve(root, 'backups', filename)

  try {
    const result = await restoreBackup({ archivePath: filePath, overwrite: true })
    const items = result.restored.join(', ')
    const warnings = result.warnings.map(w => html`<div class="alert alert-warning">${icon('alert-triangle', 14)} ${w}</div>`)
    const content = html`
      <h2>${icon('archive', 18)} ${t('bak.title')}</h2>
      <div class="alert alert-success">${icon('check', 14)} ${t('bak.restored', { items })}</div>
      ${warnings}
      <a href="/backup" role="button" class="outline">${icon('arrow-left', 14)} ${t('common.back')}</a>
    `
    return c.html(layout(t('bak.title'), content, '/backup', t, lang))
  } catch (err) {
    const msg = t('bak.restoreFailed', { error: err instanceof Error ? err.message : String(err) })
    const content = html`
      <h2>${icon('archive', 18)} ${t('bak.title')}</h2>
      <div class="alert alert-error">${icon('alert-circle', 14)} ${msg}</div>
      <a href="/backup" role="button" class="outline">${icon('arrow-left', 14)} ${t('common.back')}</a>
    `
    return c.html(layout(t('bak.title'), content, '/backup', t, lang))
  }
})

// --- Delete ---
app.post('/backup/delete/:filename', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const filename = c.req.param('filename')

  deleteBackup(filename)
  const content = html`
    <h2>${icon('archive', 18)} ${t('bak.title')}</h2>
    <div class="alert alert-success">${icon('check', 14)} ${t('bak.deleted')}</div>
    <a href="/backup" role="button" class="outline">${icon('arrow-left', 14)} ${t('common.back')}</a>
  `
  return c.html(layout(t('bak.title'), content, '/backup', t, lang))
})

// --- Schedule ---
app.post('/backup/schedule', async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const body = await c.req.parseBody()

  saveScheduleConfig({
    enabled: body['enabled'] === 'on',
    type: String(body['type'] ?? 'system') as 'bot' | 'system',
    botName: String(body['botName'] ?? ''),
    cron: String(body['cron'] ?? '0 3 * * *'),
    retentionCount: parseInt(String(body['retentionCount'] ?? '7'), 10) || 7,
  })

  const content = html`
    <h2>${icon('archive', 18)} ${t('bak.title')}</h2>
    <div class="alert alert-success">${icon('check', 14)} ${t('bak.scheduleSaved')}</div>
    <a href="/backup" role="button" class="outline">${icon('arrow-left', 14)} ${t('common.back')}</a>
  `
  return c.html(layout(t('bak.title'), content, '/backup', t, lang))
})

export default app
