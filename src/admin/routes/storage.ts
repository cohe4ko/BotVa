import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { getBotNames, getBotDir, getProjectRoot } from '../db-multi.js'
import { execSync } from 'child_process'
import { existsSync, unlinkSync, statSync, readdirSync } from 'fs'
import { resolve, join, relative } from 'path'
import { guideBlock } from '../views/components.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

function duSize(dir: string): string {
  try { return execSync(`du -sh "${dir}" 2>/dev/null`, { encoding: 'utf-8' }).split('\t')[0].trim() }
  catch { return '—' }
}

function duBytes(dir: string): number {
  try { return parseInt(execSync(`du -sk "${dir}" 2>/dev/null`, { encoding: 'utf-8' }).split('\t')[0], 10) * 1024 }
  catch { return 0 }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function fileCount(dir: string): number {
  try { return parseInt(execSync(`find "${dir}" -type f 2>/dev/null | wc -l`, { encoding: 'utf-8' }).trim(), 10) }
  catch { return 0 }
}

interface DirStat {
  name: string
  path: string
  size: string
  bytes: number
  files: number
  icon: string
}

interface FileStat {
  path: string       // relative to project root
  absPath: string
  size: string
  bytes: number
  ext: string
}

function getStorageStats(): DirStat[] {
  const root = getProjectRoot()
  const stats: DirStat[] = []

  // Bot databases
  for (const bot of getBotNames()) {
    const store = resolve(getBotDir(bot), 'store')
    if (existsSync(store)) {
      stats.push({
        name: `${bot} DB`, path: `bots/${bot}/store`,
        size: duSize(store), bytes: duBytes(store),
        files: fileCount(store), icon: 'database',
      })
    }
  }

  // Gallery DB
  const gdb = resolve(root, 'workspace', 'gallery.db')
  if (existsSync(gdb)) {
    const b = statSync(gdb).size
    stats.push({
      name: 'Gallery DB', path: 'workspace/gallery.db',
      size: formatSize(b), bytes: b, files: 1, icon: 'database',
    })
  }

  // node_modules
  const nm = resolve(root, 'node_modules')
  if (existsSync(nm)) {
    stats.push({
      name: 'node_modules', path: 'node_modules',
      size: duSize(nm), bytes: duBytes(nm),
      files: fileCount(nm), icon: 'package',
    })
  }

  // MCP servers
  const mcp = resolve(root, 'mcp-servers')
  if (existsSync(mcp)) {
    stats.push({
      name: 'MCP servers', path: 'mcp-servers',
      size: duSize(mcp), bytes: duBytes(mcp),
      files: fileCount(mcp), icon: 'plug',
    })
  }

  return stats.sort((a, b) => b.bytes - a.bytes)
}

function scanLargeFiles(minSizeKb: number = 1024): FileStat[] {
  const root = getProjectRoot()
  try {
    const output = execSync(
      `find "${root}" -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/venv/*' -type f -size +${minSizeKb}k -exec du -k {} \\; 2>/dev/null | sort -rn`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    )
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [kb, ...rest] = line.split('\t')
      const absPath = rest.join('\t')
      const bytes = parseInt(kb, 10) * 1024
      const relPath = relative(root, absPath)
      const ext = absPath.split('.').pop()?.toLowerCase() || ''
      return { path: relPath, absPath, size: formatSize(bytes), bytes, ext }
    }).slice(0, 200) // limit
  } catch { return [] }
}

// --- Routes ---

app.get('/storage', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')

  const content = html`
    <h2>${icon('hard-drive')} ${t('stor.title')}</h2>
    <div id="storage-stats"
      hx-get="/storage/stats"
      hx-trigger="load"
      hx-swap="innerHTML">
      <div class="stats-grid">
        ${Array.from({ length: 4 }).map(() => html`
          <div class="stat-card">
            <div class="stat-label" style="background:var(--mc-surface2);height:0.7rem;width:60%;border-radius:3px;margin-bottom:0.35rem"></div>
            <div style="background:var(--mc-surface2);height:1.3rem;width:40%;border-radius:4px"></div>
          </div>
        `)}
      </div>
      <p style="text-align:center;color:var(--mc-text-dim);font-size:0.82rem;margin-top:0.75rem">
        ${icon('loader', 13)} ${t('stor.calculating')}
      </p>
    </div>

    <h3>${icon('search')} ${t('stor.largeFiles')}</h3>
    <p style="font-size:0.85rem;color:var(--mc-text-secondary)">${t('stor.largeFilesDesc')}</p>

    <div id="scan-results">
      <button
        hx-get="/storage/scan"
        hx-target="#scan-results"
        hx-swap="innerHTML"
        hx-indicator="#scan-spinner"
        class="outline"
        style="margin-bottom:1rem"
      >${icon('radar', 13)} ${t('stor.scan')}</button>
      <span id="scan-spinner" class="htmx-indicator" style="margin-left:0.5rem;font-size:0.85rem;color:var(--mc-text-dim)">${t('stor.scanning')}</span>
    </div>

    ${guideBlock(t('guide.storage.title'), [t('guide.storage.1'), t('guide.storage.2'), t('guide.storage.3')])}
  `

  return c.html(layout(t('stor.title'), content, '/storage', t, lang))
})

// HTMX: load storage stats asynchronously
app.get('/storage/stats', (c) => {
  const t: TFunc = c.get('t')
  const stats = getStorageStats()

  return c.html(html`
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('hard-drive', 12)} ${t('stor.totalProject')}</div>
        <div class="stat-number">${duSize(getProjectRoot())}</div>
      </div>
      ${stats.slice(0, 11).map(d => html`
        <div class="stat-card">
          <div class="stat-label">${icon(d.icon, 12)} ${d.name}</div>
          <div class="stat-number">${d.size}</div>
          <div style="font-size:0.7rem;color:var(--mc-text-dim)">${d.files.toLocaleString()} ${t('stor.files')}</div>
        </div>
      `)}
    </div>
  `)
})

// HTMX: scan for large files
app.get('/storage/scan', (c) => {
  const t: TFunc = c.get('t')
  const files = scanLargeFiles(10240) // > 10MB
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0)

  return c.html(html`
    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.75rem">
      <button
        hx-get="/storage/scan"
        hx-target="#scan-results"
        hx-swap="innerHTML"
        hx-indicator="#scan-spinner2"
        class="outline btn-sm"
      >${icon('refresh-cw', 12)} ${t('stor.rescan')}</button>
      <span id="scan-spinner2" class="htmx-indicator" style="font-size:0.85rem;color:var(--mc-text-dim)">${t('stor.scanning')}</span>
      <span style="font-size:0.85rem;color:var(--mc-text-secondary)">
        ${t('stor.found')} <strong>${files.length}</strong> ${t('stor.files')}, ${t('stor.total')} <strong>${formatSize(totalBytes)}</strong>
      </span>
    </div>

    <form hx-post="/storage/delete" hx-target="#scan-results" hx-swap="innerHTML" hx-confirm="${t('stor.deleteConfirm')}">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:40px"><input type="checkbox" id="select-all" onchange="document.querySelectorAll('input[name=files]').forEach(cb => cb.checked = this.checked)"></th>
              <th>${t('stor.file')}</th>
              <th style="width:80px">${t('stor.ext')}</th>
              <th style="width:100px;text-align:right">${t('stor.size')}</th>
            </tr>
          </thead>
          <tbody>
            ${files.map(f => html`
              <tr>
                <td><input type="checkbox" name="files" value="${f.path}"></td>
                <td style="font-size:0.78rem;word-break:break-all"><code>${f.path}</code></td>
                <td><span class="badge" style="font-size:0.7rem">.${f.ext}</span></td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap">${f.size}</td>
              </tr>
            `)}
            ${files.length === 0 ? html`<tr><td colspan="4" style="text-align:center;color:var(--mc-text-dim)">${t('stor.noLargeFiles')}</td></tr>` : ''}
          </tbody>
        </table>
      </div>
      ${files.length > 0 ? html`
        <div style="display:flex;align-items:center;gap:0.75rem;margin-top:0.75rem">
          <button type="submit" class="outline" style="color:var(--mc-red);border-color:var(--mc-red)">
            ${icon('trash-2', 13)} ${t('stor.deleteSelected')}
          </button>
          <span id="selected-count" style="font-size:0.8rem;color:var(--mc-text-dim)"></span>
        </div>
        <script>
          (function() {
            var cbs = document.querySelectorAll('input[name=files]');
            var counter = document.getElementById('selected-count');
            function update() {
              var n = document.querySelectorAll('input[name=files]:checked').length;
              counter.textContent = n > 0 ? n + ' ${t('stor.selected')}' : '';
            }
            cbs.forEach(function(cb) { cb.addEventListener('change', update); });
            document.getElementById('select-all').addEventListener('change', update);
          })();
        </script>
      ` : ''}
    </form>
  `)
})

// Delete selected files
app.post('/storage/delete', async (c) => {
  const t: TFunc = c.get('t')
  const body = await c.req.parseBody({ all: true })
  const root = getProjectRoot()

  // parseBody returns string for single, array for multiple
  let filePaths: string[] = []
  const raw = body['files']
  if (typeof raw === 'string') {
    filePaths = [raw]
  } else if (Array.isArray(raw)) {
    filePaths = raw.map(String)
  }

  let deleted = 0
  let errors: string[] = []

  for (const relPath of filePaths) {
    // Security: prevent path traversal
    if (relPath.includes('..') || relPath.startsWith('/')) {
      errors.push(`Blocked: ${relPath}`)
      continue
    }

    const absPath = resolve(root, relPath)
    // Must be within project root
    if (!absPath.startsWith(root)) {
      errors.push(`Outside project: ${relPath}`)
      continue
    }

    // Don't allow deleting critical files
    if (relPath.startsWith('src/') || relPath === 'package.json' || relPath === 'tsconfig.json' || relPath.endsWith('.ts')) {
      errors.push(`Protected: ${relPath}`)
      continue
    }

    try {
      if (existsSync(absPath)) {
        unlinkSync(absPath)
        deleted++
      }
    } catch (e: any) {
      errors.push(`${relPath}: ${e.message}`)
    }
  }

  // Return updated scan results with status message
  const files = scanLargeFiles(10240)
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0)

  return c.html(html`
    <div style="padding:0.75rem;margin-bottom:0.75rem;border-radius:6px;background:var(--mc-bg-secondary);border:1px solid var(--mc-border)">
      ${icon('check', 14)} ${t('stor.deleted')} <strong>${deleted}</strong> ${t('stor.files')}
      ${errors.length > 0 ? html`
        <div style="margin-top:0.5rem;color:var(--mc-red);font-size:0.8rem">
          ${errors.map(e => html`<div>${icon('alert-circle', 11)} ${e}</div>`)}
        </div>
      ` : ''}
    </div>

    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.75rem">
      <button
        hx-get="/storage/scan"
        hx-target="#scan-results"
        hx-swap="innerHTML"
        hx-indicator="#scan-spinner3"
        class="outline btn-sm"
      >${icon('refresh-cw', 12)} ${t('stor.rescan')}</button>
      <span id="scan-spinner3" class="htmx-indicator" style="font-size:0.85rem;color:var(--mc-text-dim)">${t('stor.scanning')}</span>
      <span style="font-size:0.85rem;color:var(--mc-text-secondary)">
        ${t('stor.found')} <strong>${files.length}</strong> ${t('stor.files')}, ${t('stor.total')} <strong>${formatSize(totalBytes)}</strong>
      </span>
    </div>

    <form hx-post="/storage/delete" hx-target="#scan-results" hx-swap="innerHTML" hx-confirm="${t('stor.deleteConfirm')}">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:40px"><input type="checkbox" id="select-all" onchange="document.querySelectorAll('input[name=files]').forEach(cb => cb.checked = this.checked)"></th>
              <th>${t('stor.file')}</th>
              <th style="width:80px">${t('stor.ext')}</th>
              <th style="width:100px;text-align:right">${t('stor.size')}</th>
            </tr>
          </thead>
          <tbody>
            ${files.map(f => html`
              <tr>
                <td><input type="checkbox" name="files" value="${f.path}"></td>
                <td style="font-size:0.78rem;word-break:break-all"><code>${f.path}</code></td>
                <td><span class="badge" style="font-size:0.7rem">.${f.ext}</span></td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap">${f.size}</td>
              </tr>
            `)}
            ${files.length === 0 ? html`<tr><td colspan="4" style="text-align:center;color:var(--mc-text-dim)">${t('stor.noLargeFiles')}</td></tr>` : ''}
          </tbody>
        </table>
      </div>
      ${files.length > 0 ? html`
        <div style="display:flex;align-items:center;gap:0.75rem;margin-top:0.75rem">
          <button type="submit" class="outline" style="color:var(--mc-red);border-color:var(--mc-red)">
            ${icon('trash-2', 13)} ${t('stor.deleteSelected')}
          </button>
          <span id="selected-count" style="font-size:0.8rem;color:var(--mc-text-dim)"></span>
        </div>
        <script>
          (function() {
            var cbs = document.querySelectorAll('input[name=files]');
            var counter = document.getElementById('selected-count');
            function update() {
              var n = document.querySelectorAll('input[name=files]:checked').length;
              counter.textContent = n > 0 ? n + ' ${t('stor.selected')}' : '';
            }
            cbs.forEach(function(cb) { cb.addEventListener('change', update); });
            document.getElementById('select-all').addEventListener('change', update);
          })();
        </script>
      ` : ''}
    </form>
  `)
})

export default app
