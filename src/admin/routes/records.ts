import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { truncate } from '../views/components.js'
import { getProjectRoot } from '../db-multi.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

const DATA_DIR = join(getProjectRoot(), 'workspace', 'listener')

// --- Helpers ---

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function safeDirList(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
  } catch { return [] }
}

function safeFileList(dir: string, ext?: string): string[] {
  if (!existsSync(dir)) return []
  try {
    const files = readdirSync(dir).filter(f => !ext || f.endsWith(ext))
    return files.sort()
  } catch { return [] }
}

function safeReadJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch { return null }
}

function safeReadText(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch { return '' }
}

function totalDirSize(dir: string, ext?: string): number {
  const files = safeFileList(dir, ext)
  let total = 0
  for (const f of files) {
    try { total += statSync(join(dir, f)).size } catch {}
  }
  return total
}

interface DateInfo {
  date: string
  chunkCount: number
  audioSize: number
}

function getDateList(): DateInfo[] {
  const transcriptsDir = join(DATA_DIR, 'transcripts')
  const audioDir = join(DATA_DIR, 'audio')
  const dates = safeDirList(transcriptsDir)

  return dates.map(date => {
    const chunkCount = safeFileList(join(transcriptsDir, date), '.json').length
    const audioSize = totalDirSize(join(audioDir, date), '.wav')
    return { date, chunkCount, audioSize }
  }).sort((a, b) => b.date.localeCompare(a.date))
}

interface TranscriptChunk {
  filename: string
  timestamp: string
  device: string
  text: string
  provider: string
  audioFile: string | null
  analyzed: any | null
}

function getChunksForDate(date: string): TranscriptChunk[] {
  const transcriptsDir = join(DATA_DIR, 'transcripts', date)
  const audioDir = join(DATA_DIR, 'audio', date)
  const analyzedDir = join(DATA_DIR, 'analyzed', date)

  const files = safeFileList(transcriptsDir, '.json')

  return files.map(filename => {
    const data = safeReadJson(join(transcriptsDir, filename))
    if (!data) return null

    const baseName = filename.replace(/\.json$/, '')
    const audioFile = existsSync(join(audioDir, `${baseName}.wav`))
      ? `${baseName}.wav`
      : null

    const analyzed = safeReadJson(join(analyzedDir, filename))

    return {
      filename,
      timestamp: data.timestamp ?? '',
      device: data.device ?? 'unknown',
      text: data.text ?? '',
      provider: data.provider ?? '',
      audioFile,
      analyzed,
    } as TranscriptChunk
  }).filter(Boolean).sort((a, b) => a!.timestamp.localeCompare(b!.timestamp)) as TranscriptChunk[]
}

function formatTime(timestamp: string): string {
  // timestamp format: "2026-03-19T20-50-14" or ISO
  const match = timestamp.match(/T(\d{2})-(\d{2})/)
  if (match) return `${match[1]}:${match[2]}`
  const isoMatch = timestamp.match(/T(\d{2}):(\d{2})/)
  if (isoMatch) return `${isoMatch[1]}:${isoMatch[2]}`
  return timestamp
}

interface DeviceStatus {
  name: string
  online: boolean
  cpu_temp?: number
  uptime?: number
  queue_size?: number
}

async function fetchDevices(): Promise<DeviceStatus[] | null> {
  try {
    const resp = await fetch('http://localhost:3847/devices', { signal: AbortSignal.timeout(3000) })
    if (!resp.ok) return null
    const data = await resp.json() as any
    // Normalize: could be array or object with devices key
    if (Array.isArray(data)) return data
    if (data.devices && Array.isArray(data.devices)) return data.devices
    // Object keyed by device name
    if (typeof data === 'object') {
      return Object.entries(data).map(([name, info]: [string, any]) => ({
        name,
        online: info.online !== undefined ? info.online : (info.status === 'online'),
        cpu_temp: info.cpu_temp,
        uptime: info.uptime,
        queue_size: info.queue_size,
      }))
    }
    return null
  } catch { return null }
}

function formatUptime(seconds?: number): string {
  if (!seconds) return '--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 24) {
    const d = Math.floor(h / 24)
    return `${d}d ${h % 24}h`
  }
  return `${h}h ${m}m`
}

function renderDevicesFragment(devices: DeviceStatus[] | null) {
  if (!devices) {
    return html`
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">${icon('radio', 12)} Receiver</div>
          <div class="stat-number" style="font-size:1rem">
            <span class="badge badge-missing">${icon('x', 11)} Offline</span>
          </div>
        </div>
      </div>
    `
  }

  if (devices.length === 0) {
    return html`
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">${icon('radio', 12)} Receiver</div>
          <div class="stat-number" style="font-size:1rem">
            <span class="badge badge-set">${icon('check', 11)} Online</span>
          </div>
          <div style="font-size:0.75rem;color:var(--mc-text-dim)">No devices registered</div>
        </div>
      </div>
    `
  }

  return html`
    <div class="stats-grid">
      ${devices.map(d => html`
        <div class="stat-card">
          <div class="stat-label">${icon('cpu', 12)} ${d.name}</div>
          <div class="stat-number" style="font-size:1rem">
            ${d.online
              ? html`<span class="badge badge-set">${icon('check', 11)} Online</span>`
              : html`<span class="badge badge-missing">${icon('x', 11)} Offline</span>`
            }
          </div>
          <div style="font-size:0.72rem;color:var(--mc-text-dim);margin-top:0.25rem">
            ${d.cpu_temp != null ? html`${icon('thermometer', 10)} ${d.cpu_temp.toFixed(1)}°C &nbsp;` : ''}
            ${d.uptime != null ? html`${icon('timer', 10)} ${formatUptime(d.uptime)} &nbsp;` : ''}
            ${d.queue_size != null ? html`${icon('list', 10)} queue: ${d.queue_size}` : ''}
          </div>
        </div>
      `)}
    </div>
  `
}

// --- Routes ---

// GET /records -- date list page
app.get('/records', async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')

  const dates = getDateList()

  const content = html`
    <h2>${icon('mic')} Records</h2>

    <h3>${icon('radio')} Devices</h3>
    <div id="devices-status"
      hx-get="/records/devices-status"
      hx-trigger="load, every 30s"
      hx-swap="innerHTML">
      <span style="color:var(--mc-text-dim)">${icon('loader', 13)} Loading...</span>
    </div>

    <h3 style="margin-top:1.5rem">${icon('calendar')} Recordings</h3>
    ${dates.length === 0
      ? html`<p style="color:var(--mc-text-dim)">No recordings yet. Listener data will appear in <code>workspace/listener/</code>.</p>`
      : html`
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th style="text-align:right">Chunks</th>
                <th style="text-align:right">Audio size</th>
                <th style="width:60px"></th>
              </tr>
            </thead>
            <tbody>
              ${dates.map(d => html`
                <tr>
                  <td><strong>${d.date}</strong></td>
                  <td style="text-align:right;font-variant-numeric:tabular-nums">${d.chunkCount}</td>
                  <td style="text-align:right;font-variant-numeric:tabular-nums">${formatSize(d.audioSize)}</td>
                  <td>
                    <a href="/records/${d.date}" class="btn-sm outline" style="text-decoration:none">${icon('eye', 11)}</a>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      `
    }
  `

  return c.html(layout('Records', content, '/records', t, lang))
})

// GET /records/devices-status -- htmx fragment
app.get('/records/devices-status', async (c) => {
  const devices = await fetchDevices()
  return c.html(renderDevicesFragment(devices))
})

// GET /records/:date -- day detail page
app.get('/records/:date', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const date = c.req.param('date')

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.text('Invalid date format', 400)
  }

  const chunks = getChunksForDate(date)
  const audioDir = join(DATA_DIR, 'audio', date)
  const totalAudio = totalDirSize(audioDir, '.wav')

  // Daily summary
  const summaryPath = join(DATA_DIR, 'summaries', `${date}.md`)
  const summary = safeReadText(summaryPath)

  const content = html`
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem">
      <a href="/records" style="color:var(--mc-text-dim);text-decoration:none">${icon('arrow-left', 16)}</a>
      <h2 style="margin:0">${icon('mic')} ${date}</h2>
    </div>

    ${summary ? html`
      <h3>${icon('file-text')} Daily Summary</h3>
      <div style="background:var(--mc-bg-secondary);border:1px solid var(--mc-border);border-radius:8px;padding:1rem;margin-bottom:1.5rem;white-space:pre-wrap;font-size:0.85rem;line-height:1.6">${summary}</div>
    ` : ''}

    <div class="stats-grid" style="margin-bottom:1.5rem">
      <div class="stat-card">
        <div class="stat-label">${icon('hash', 12)} Chunks</div>
        <div class="stat-number">${chunks.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('hard-drive', 12)} Audio size</div>
        <div class="stat-number">${formatSize(totalAudio)}</div>
      </div>
    </div>

    <h3>${icon('list')} Timeline</h3>
    ${chunks.length === 0
      ? html`<p style="color:var(--mc-text-dim)">No transcripts for this date.</p>`
      : chunks.map(chunk => html`
        <div style="background:var(--mc-bg-secondary);border:1px solid var(--mc-border);border-radius:8px;padding:0.75rem 1rem;margin-bottom:0.75rem">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap">
            <strong style="font-variant-numeric:tabular-nums">${formatTime(chunk.timestamp)}</strong>
            <span class="badge" style="font-size:0.7rem">${icon('cpu', 10)} ${chunk.device}</span>
            ${chunk.provider ? html`<span class="badge" style="font-size:0.65rem;opacity:0.7">${chunk.provider}</span>` : ''}
          </div>

          ${chunk.audioFile ? html`
            <div style="margin-bottom:0.5rem">
              <audio controls preload="none" style="width:100%;max-width:400px;height:32px">
                <source src="/records-audio/${date}/${chunk.audioFile}" type="audio/wav">
              </audio>
            </div>
          ` : ''}

          ${chunk.text.length > 300
            ? html`
              <div style="font-size:0.85rem;line-height:1.5">${truncate(chunk.text, 300)}</div>
              <details style="margin-top:0.25rem">
                <summary style="font-size:0.75rem;color:var(--mc-text-dim);cursor:pointer">Full transcript</summary>
                <div style="font-size:0.85rem;line-height:1.5;margin-top:0.35rem;white-space:pre-wrap">${chunk.text}</div>
              </details>
            `
            : html`<div style="font-size:0.85rem;line-height:1.5">${chunk.text}</div>`
          }

          ${chunk.analyzed ? renderAnalyzed(chunk.analyzed) : ''}
        </div>
      `)
    }
  `

  return c.html(layout(`Records: ${date}`, content, '/records', t, lang))
})

function renderAnalyzed(analyzed: any) {
  const { facts, decisions, tasks, topics, summary: aSummary } = analyzed
  const hasData = (facts?.length || decisions?.length || tasks?.length || topics?.length || aSummary)
  if (!hasData) return ''

  return html`
    <div style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--mc-border)">
      ${topics?.length ? html`
        <div style="margin-bottom:0.35rem">
          ${topics.map((t: string) => html`<span class="badge" style="font-size:0.65rem;margin-right:0.25rem;margin-bottom:0.2rem">${icon('tag', 9)} ${t}</span>`)}
        </div>
      ` : ''}
      ${aSummary ? html`
        <div style="font-size:0.78rem;color:var(--mc-text-secondary);margin-bottom:0.35rem">${icon('align-left', 10)} ${aSummary}</div>
      ` : ''}
      ${facts?.length ? html`
        <div style="font-size:0.75rem;margin-bottom:0.25rem">
          ${icon('lightbulb', 10)} <strong>Facts:</strong>
          ${facts.map((f: string) => html`<span style="display:inline-block;background:var(--mc-surface2);border-radius:4px;padding:0.1rem 0.4rem;margin:0.1rem 0.15rem;font-size:0.72rem">${f}</span>`)}
        </div>
      ` : ''}
      ${decisions?.length ? html`
        <div style="font-size:0.75rem;margin-bottom:0.25rem">
          ${icon('check-circle', 10)} <strong>Decisions:</strong>
          ${decisions.map((d: string) => html`<span style="display:inline-block;background:var(--mc-surface2);border-radius:4px;padding:0.1rem 0.4rem;margin:0.1rem 0.15rem;font-size:0.72rem">${d}</span>`)}
        </div>
      ` : ''}
      ${tasks?.length ? html`
        <div style="font-size:0.75rem;margin-bottom:0.25rem">
          ${icon('circle-dot', 10)} <strong>Tasks:</strong>
          ${tasks.map((t: string) => html`<span style="display:inline-block;background:var(--mc-surface2);border-radius:4px;padding:0.1rem 0.4rem;margin:0.1rem 0.15rem;font-size:0.72rem">${t}</span>`)}
        </div>
      ` : ''}
    </div>
  `
}

// GET /records/transcript/:date/:file -- full transcript JSON API
app.get('/records/transcript/:date/:file', (c) => {
  const date = c.req.param('date')
  const file = c.req.param('file')

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.text('Invalid date', 400)
  if (!/^[\w\-]+\.json$/.test(file)) return c.text('Invalid file', 400)

  const filePath = join(DATA_DIR, 'transcripts', date, file)
  const data = safeReadJson(filePath)
  if (!data) return c.json({ error: 'Not found' }, 404)

  return c.json(data)
})

export default app
