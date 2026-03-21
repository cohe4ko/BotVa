import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { guideBlock } from '../views/components.js'
import { getProjectRoot, getBotNames, insertFactForBot } from '../db-multi.js'
import { readEnv } from '../env-parser.js'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import { getFactsForDate, collectPendingFacts, reviewFact, type FactReviewItem } from '../../listener-facts.js'
import { analyzeTranscript, cleanWhisperHallucinations, normalizeItem, type AnalysisItem } from '../../listener-analyze.js'

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
    const audioSize = totalDirSize(join(audioDir, date))
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
    const filePath = join(transcriptsDir, filename)
    const data = safeReadJson(filePath)
    if (!data) return null

    // Clean hallucinations on read and persist
    if (data.text) {
      const cleaned = cleanWhisperHallucinations(data.text)
      if (cleaned !== data.text) {
        data.text = cleaned
        try { writeFileSync(filePath, JSON.stringify(data, null, 2)) } catch {}
      }
    }

    const baseName = filename.replace(/\.json$/, '')
    const audioFile = existsSync(join(audioDir, `${baseName}.ogg`))
      ? `${baseName}.ogg`
      : existsSync(join(audioDir, `${baseName}.wav`))
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

function renderDevicesFragment(devices: DeviceStatus[] | null, t: TFunc) {
  if (!devices) {
    return html`
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">${icon('radio', 12)} Receiver</div>
          <div class="stat-number" style="font-size:1rem">
            <span class="badge badge-missing">${icon('x', 11)} ${t('records.offline')}</span>
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
            <span class="badge badge-set">${icon('check', 11)} ${t('records.online')}</span>
          </div>
          <div style="font-size:0.75rem;color:var(--mc-text-dim)">${t('records.noDevicesRegistered')}</div>
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
              ? html`<span class="badge badge-set">${icon('check', 11)} ${t('records.online')}</span>`
              : html`<span class="badge badge-missing">${icon('x', 11)} ${t('records.offline')}</span>`
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
    <h2>${icon('mic')} ${t('records.title')}</h2>
    <h3>${icon('radio')} ${t('records.devices')}</h3>
    <div id="devices-status"
      hx-get="/records/devices-status"
      hx-trigger="load, every 30s"
      hx-swap="innerHTML">
      <span style="color:var(--mc-text-dim)">${icon('loader', 13)} ...</span>
    </div>

    <details style="margin-top:1.5rem;margin-bottom:1.5rem">
      <summary style="cursor:pointer;font-size:1rem;font-weight:600">${icon('plus-circle')} ${t('records.addDevice')}</summary>
      <div style="background:var(--mc-bg-secondary);border:1px solid var(--mc-border);border-radius:8px;padding:1rem;margin-top:0.5rem">
        <p style="font-size:0.85rem;color:var(--mc-text-dim);margin-top:0">
          ${t('records.addDeviceDesc')}
        </p>

        <form id="setup-form" onsubmit="return false" style="display:flex;flex-direction:column;gap:0.75rem">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div>
              <label style="font-size:0.75rem;font-weight:500">${t('records.sshTarget')}</label>
              <input id="sf-ssh" type="text" placeholder="user@device-ip" style="width:100%;padding:0.4rem 0.6rem;border:1px solid var(--mc-border);border-radius:6px;background:var(--mc-bg);color:var(--mc-text);font-size:0.85rem" />
            </div>
            <div>
              <label style="font-size:0.75rem;font-weight:500">${t('records.deviceId')}</label>
              <input id="sf-device" type="text" placeholder="opi-livingroom" style="width:100%;padding:0.4rem 0.6rem;border:1px solid var(--mc-border);border-radius:6px;background:var(--mc-bg);color:var(--mc-text);font-size:0.85rem" />
            </div>
          </div>

          <details>
            <summary style="font-size:0.8rem;cursor:pointer;color:var(--mc-text-dim)">${t('records.advancedOptions')}</summary>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.5rem;margin-top:0.5rem">
              <div>
                <label style="font-size:0.7rem">${t('records.chunkDuration')}</label>
                <input id="sf-chunk" type="number" value="300" style="width:100%;padding:0.3rem 0.5rem;border:1px solid var(--mc-border);border-radius:6px;background:var(--mc-bg);color:var(--mc-text);font-size:0.8rem" />
              </div>
              <div>
                <label style="font-size:0.7rem">${t('records.overlap')}</label>
                <input id="sf-overlap" type="number" value="10" style="width:100%;padding:0.3rem 0.5rem;border:1px solid var(--mc-border);border-radius:6px;background:var(--mc-bg);color:var(--mc-text);font-size:0.8rem" />
              </div>
              <div>
                <label style="font-size:0.7rem">${t('records.tmpfsSize')}</label>
                <input id="sf-tmpfs" type="number" value="100" style="width:100%;padding:0.3rem 0.5rem;border:1px solid var(--mc-border);border-radius:6px;background:var(--mc-bg);color:var(--mc-text);font-size:0.8rem" />
              </div>
            </div>
          </details>

          <div>
            <button type="button" onclick="generateSetupCmd()" class="btn-sm" style="padding:0.4rem 1rem;cursor:pointer">
              ${icon('terminal', 12)} ${t('records.generateCmd')}
            </button>
          </div>
        </form>

        <div id="setup-output" style="display:none;margin-top:0.75rem">
          <label style="font-size:0.75rem;font-weight:500">${t('records.runOnServer')}</label>
          <pre id="setup-cmd" style="background:var(--mc-surface2);border:1px solid var(--mc-border);border-radius:6px;padding:0.75rem;font-size:0.78rem;overflow-x:auto;cursor:pointer;position:relative" onclick="copyCmd(this)"></pre>
          <span id="copy-hint" style="font-size:0.7rem;color:var(--mc-text-dim)">${t('records.clickToCopy')}</span>
        </div>

        <div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--mc-border)">
          <details>
            <summary style="font-size:0.8rem;cursor:pointer;color:var(--mc-text-dim)">${icon('book', 11)} ${t('records.whatSetupDoes')}</summary>
            <div style="font-size:0.78rem;line-height:1.6;margin-top:0.5rem;color:var(--mc-text-secondary)">
              <ol style="padding-left:1.2rem;margin:0">
                <li>${t('records.setupStep1')}</li>
                <li>${t('records.setupStep2')}</li>
                <li>${t('records.setupStep3')}</li>
                <li>${t('records.setupStep4')}</li>
                <li>${t('records.setupStep5')}</li>
                <li>${t('records.setupStep6')}</li>
                <li>${t('records.setupStep7')}</li>
                <li>${t('records.setupStep8')}</li>
                <li>${t('records.setupStep9')}</li>
                <li>${t('records.setupStep10')}</li>
              </ol>
              <p style="margin:0.5rem 0 0 0">
                <strong>${t('records.ledIndicators')}</strong> 🔴 ${t('records.ledRecording')} &bull; 🔴🟢 ${t('records.ledUploading')} &bull; 🟢 ${t('records.ledSafe')}
              </p>
              <p style="margin:0.25rem 0 0 0">
                <strong>${t('records.buttonAction')}</strong> ${t('records.buttonDesc')}
              </p>
            </div>
          </details>
        </div>
      </div>
    </details>

    <script>
    function generateSetupCmd() {
      const ssh = document.getElementById('sf-ssh').value.trim();
      const device = document.getElementById('sf-device').value.trim();
      const chunk = document.getElementById('sf-chunk').value || '300';
      const overlap = document.getElementById('sf-overlap').value || '10';
      const tmpfs = document.getElementById('sf-tmpfs').value || '100';

      if (!ssh || !device) {
        alert('SSH target and Device ID are required');
        return;
      }

      const receiverUrl = 'http://' + location.hostname + ':3847/audio';
      let cmd = '';
      if (chunk !== '300' || overlap !== '10' || tmpfs !== '100') {
        const envParts = [];
        if (chunk !== '300') envParts.push('CHUNK_DURATION=' + chunk);
        if (overlap !== '10') envParts.push('CHUNK_OVERLAP=' + overlap);
        if (tmpfs !== '100') envParts.push('TMPFS_SIZE=' + tmpfs + 'M');
        cmd = envParts.join(' ') + ' ';
      }
      cmd += 'scripts/orange-pi-listener/setup-device.sh ' + ssh + ' ' + device + ' ' + receiverUrl;

      document.getElementById('setup-cmd').textContent = cmd;
      document.getElementById('setup-output').style.display = 'block';
    }
    function copyCmd(el) {
      navigator.clipboard.writeText(el.textContent);
      document.getElementById('copy-hint').textContent = '${t('records.copied')}';
      setTimeout(() => { document.getElementById('copy-hint').textContent = '${t('records.clickToCopy')}'; }, 2000);
    }
    </script>

    <h3 style="margin-top:1.5rem">${icon('calendar')} ${t('records.recordings')}</h3>
    ${dates.length === 0
      ? html`<p style="color:var(--mc-text-dim)">${t('records.noRecords')}. ${t('records.noRecordsHint')} <code>workspace/listener/</code>.</p>`
      : html`
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>${t('records.date')}</th>
                <th style="text-align:right">${t('records.chunks')}</th>
                <th style="text-align:right">${t('records.audioSize')}</th>
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

    ${guideBlock(t('guide.records.title'), [t('guide.records.1'), t('guide.records.2'), t('guide.records.3')])}
  `

  return c.html(layout(t('records.title'), content, '/records', t, lang))
})

// GET /records/devices-status -- htmx fragment
app.get('/records/devices-status', async (c) => {
  const t: TFunc = c.get('t')
  const devices = await fetchDevices()
  return c.html(renderDevicesFragment(devices, t))
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
  collectPendingFacts()
  const reviewItems = getFactsForDate(date)
  const audioDir = join(DATA_DIR, 'audio', date)
  const totalAudio = totalDirSize(audioDir)

  // Day-level analysis (from "extract facts for day")
  const dayAnalysis = safeReadJson(join(DATA_DIR, 'analyzed', date, `${date}-day.json`))

  // Daily summary
  const summaryPath = join(DATA_DIR, 'summaries', `${date}.md`)
  const summary = safeReadText(summaryPath)

  const content = html`
    <style>
      @keyframes highlight-fade {
        from { background-color: rgba(74, 158, 255, 0.15); }
        to { background-color: transparent; }
      }
      .new-item { animation: highlight-fade 3s ease-out; }
    </style>
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem">
      <a href="/records" style="color:var(--mc-text-dim);text-decoration:none">${icon('arrow-left', 16)}</a>
      <h2 style="margin:0">${icon('mic')} ${date}</h2>
    </div>

    ${summary ? html`
      <details style="margin-bottom:1.5rem">
        <summary style="cursor:pointer;font-size:1rem;font-weight:600;padding:0.5rem 0">${icon('file-text')} ${t('records.dailySummary')}</summary>
        <div style="background:var(--mc-bg-secondary);border:1px solid var(--mc-border);border-radius:8px;padding:1rem;margin-top:0.5rem;white-space:pre-wrap;font-size:0.85rem;line-height:1.6">${summary}</div>
      </details>
    ` : ''}

    <div class="stats-grid" style="margin-bottom:1.5rem">
      <div class="stat-card">
        <div class="stat-label">${icon('hash', 12)} ${t('records.chunks')}</div>
        <div class="stat-number">${chunks.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('hard-drive', 12)} ${t('records.audioSize')}</div>
        <div class="stat-number">${formatSize(totalAudio)}</div>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem;flex-wrap:wrap">
      <h3 style="margin:0">${icon('list')} ${t('records.timeline')}</h3>
      <div style="display:flex;align-items:center;gap:0.4rem;margin-left:auto">
        <label style="font-size:0.75rem;color:var(--mc-text-dim)">${t('records.saveToBot')}:</label>
        <select id="target-bot" style="height:28px;padding:0 0.4rem;font-size:0.75rem;border-radius:4px;border:1px solid var(--mc-border);background:var(--mc-bg);color:var(--mc-text)">
          ${getBotNames().map(b => html`<option value="${b}">${b}</option>`)}
        </select>
        ${chunks.length > 0 ? html`
          <button
            class="btn-sm"
            style="padding:0.3rem 0.7rem;font-size:0.75rem;cursor:pointer"
            id="analyze-day-btn"
            onclick="reanalyzeDay('${date}')"
          >${icon('zap', 11)} ${t('records.extractFactsDay')}</button>
        ` : ''}
      </div>
    </div>
    ${chunks.length === 0
      ? html`<p style="color:var(--mc-text-dim)">${t('records.noTranscripts')}</p>`
      : chunks.map(chunk => html`
        <div style="background:var(--mc-bg-secondary);border:1px solid var(--mc-border);border-radius:8px;padding:0.75rem 1rem;margin-bottom:0.75rem">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap">
            <strong style="font-variant-numeric:tabular-nums">${formatTime(chunk.timestamp)}</strong>
            <span class="badge" style="font-size:0.7rem">${icon('cpu', 10)} ${chunk.device}</span>
            ${chunk.provider ? html`<span class="badge" style="font-size:0.65rem;opacity:0.7">${chunk.provider}</span>` : ''}
          </div>

          ${chunk.audioFile ? html`
            <div style="margin-bottom:0.5rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
              <audio controls preload="none" style="max-width:400px;height:32px;flex:1;min-width:200px">
                <source src="/records-audio/${date}/${chunk.audioFile}" type="${chunk.audioFile?.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav'}">
              </audio>
              <div style="display:flex;align-items:center;gap:0.3rem" id="retrans-${chunk.filename.replace('.json', '')}">
                <select style="height:28px;padding:0 0.4rem;font-size:0.7rem;border-radius:4px;border:1px solid var(--mc-border);background:var(--mc-bg);color:var(--mc-text);min-width:80px" id="retrans-lang-${chunk.filename.replace('.json', '')}">
                  <option value="auto">🌐 Auto</option>
                  <option value="uk">🇺🇦 UK</option>
                  <option value="ru">🇷🇺 RU</option>
                  <option value="en">🇬🇧 EN</option>
                  <option value="de">🇩🇪 DE</option>
                  <option value="fr">🇫🇷 FR</option>
                  <option value="es">🇪🇸 ES</option>
                  <option value="it">🇮🇹 IT</option>
                  <option value="pt">🇵🇹 PT</option>
                  <option value="pl">🇵🇱 PL</option>
                  <option value="nl">🇳🇱 NL</option>
                  <option value="ja">🇯🇵 JA</option>
                  <option value="ko">🇰🇷 KO</option>
                  <option value="zh">🇨🇳 ZH</option>
                  <option value="ar">🇸🇦 AR</option>
                  <option value="hi">🇮🇳 HI</option>
                  <option value="tr">🇹🇷 TR</option>
                  <option value="sv">🇸🇪 SV</option>
                  <option value="da">🇩🇰 DA</option>
                  <option value="no">🇳🇴 NO</option>
                  <option value="fi">🇫🇮 FI</option>
                  <option value="cs">🇨🇿 CS</option>
                  <option value="hu">🇭🇺 HU</option>
                </select>
                <button
                  class="btn-sm outline"
                  style="height:28px;padding:0 0.5rem;font-size:0.7rem;white-space:nowrap"
                  onclick="retranscribe('${date}', '${chunk.filename}', '${chunk.filename.replace('.json', '')}')"
                >${icon('refresh-cw', 10)} ${t('records.reSTT')}</button>
              </div>
            </div>
          ` : ''}

          <div style="font-size:0.85rem;line-height:1.6;white-space:pre-wrap;color:var(--mc-text-secondary)">${chunk.text}</div>

          <div style="margin-top:0.3rem;display:flex;align-items:center;gap:0.4rem">
            <button
              class="btn-sm outline"
              style="height:24px;padding:0 0.5rem;font-size:0.7rem;white-space:nowrap"
              id="analyze-btn-${chunk.filename.replace('.json', '')}"
              onclick="reanalyze('${date}', '${chunk.filename}', '${chunk.filename.replace('.json', '')}')"
            >${icon('zap', 10)} ${t('records.extractFacts')}</button>
          </div>

          ${chunk.analyzed ? renderAnalyzed(chunk.analyzed, chunk.timestamp, reviewItems, t) : ''}
        </div>
      `)
    }

    ${dayAnalysis ? html`
      <div style="background:var(--mc-bg-secondary);border:2px solid var(--mc-accent, #4a9eff);border-radius:8px;padding:0.75rem 1rem;margin-top:1rem">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">
          <strong>${icon('zap')} ${t('records.dayAnalysis')}</strong>
          <span class="badge" style="font-size:0.7rem">${icon('cpu', 10)} all chunks</span>
        </div>
        ${renderAnalyzed(dayAnalysis, `${date}T00-00-00`, reviewItems, t)}
      </div>
    ` : ''}
  `

  const retranscribeScript = html`
    <script>
    async function retranscribe(date, file, baseId) {
      const lang = document.getElementById('retrans-lang-' + baseId).value;
      const container = document.getElementById('retrans-' + baseId);
      const btn = container.querySelector('button');
      const origText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '⏳ ...';

      try {
        const res = await fetch('/records/retranscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, file, language: lang })
        });
        const data = await res.json();
        if (data.ok) {
          btn.innerHTML = '✅';
          setTimeout(() => location.reload(), 800);
        } else {
          btn.innerHTML = '❌ ' + (data.error || 'Error');
          setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 3000);
        }
      } catch (e) {
        btn.innerHTML = '❌ Failed';
        setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 3000);
      }
    }
    async function reanalyzeDay(date) {
      const btn = document.getElementById('analyze-day-btn');
      const origText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '⏳ Analyzing...';

      try {
        const res = await fetch('/records/reanalyze-day', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date })
        });
        const data = await res.json();
        if (data.ok) {
          btn.innerHTML = '✅ ' + data.facts + ' facts';
          setTimeout(() => location.reload(), 1000);
        } else {
          btn.innerHTML = '❌ ' + (data.error || 'Error');
          setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 3000);
        }
      } catch (e) {
        btn.innerHTML = '❌ Failed';
        setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 3000);
      }
    }
    async function reviewFact(id, status) {
      const bot = document.getElementById('target-bot').value;
      try {
        const res = await fetch('/records/review-fact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, status, bot })
        });
        const data = await res.json();
        if (data.ok) {
          location.reload();
        }
      } catch (e) {}
    }
    async function reanalyze(date, file, baseId) {
      const btn = document.getElementById('analyze-btn-' + baseId);
      const origText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '⏳ ...';

      try {
        const res = await fetch('/records/reanalyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, file })
        });
        const data = await res.json();
        if (data.ok) {
          btn.innerHTML = '✅ ' + data.facts + ' items';
          setTimeout(() => location.reload(), 1000);
        } else {
          btn.innerHTML = '❌ ' + (data.error || 'Error');
          setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 3000);
        }
      } catch (e) {
        btn.innerHTML = '❌ Failed';
        setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 3000);
      }
    }
    </script>
  `

  return c.html(layout(`${t('records.title')}: ${date}`, html`${content}${retranscribeScript}`, '/records', t, lang))
})

function renderFactItem(rawItem: string | AnalysisItem, typeIcon: string, timestamp: string, type: string, index: number, reviewItems: FactReviewItem[], isNew = false) {
  const item = normalizeItem(rawItem)
  const id = `${timestamp}:${type}:${index}`
  const review = reviewItems.find(r => r.id === id)
  const status = review?.status

  const statusBadge = status === 'approved'
    ? html`<span class="badge badge-set" style="font-size:0.7rem">✅</span>`
    : status === 'declined'
    ? html`<span class="badge badge-missing" style="font-size:0.7rem">❌</span>`
    : html`<span style="display:inline-flex;gap:0.2rem">
        <button class="btn-sm" style="height:24px;padding:0 0.5rem;font-size:0.7rem;cursor:pointer" onclick="reviewFact('${id}','approved')">✅ Save</button>
        <button class="btn-sm outline" style="height:24px;padding:0 0.5rem;font-size:0.7rem;cursor:pointer" onclick="reviewFact('${id}','declined')">❌</button>
      </span>`

  return html`
    <div class="${isNew ? 'new-item' : ''}" style="display:flex;align-items:flex-start;gap:0.5rem;padding:0.35rem 0.4rem;border-radius:6px;${status === 'declined' ? 'opacity:0.35;' : ''}">
      <span style="flex-shrink:0;margin-top:0.1rem">${typeIcon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.88rem;line-height:1.5">${item.text}</div>
        ${item.topic || item.tags ? html`
          <div style="font-size:0.7rem;color:var(--mc-text-dim);margin-top:0.1rem">
            ${item.topic ? html`<span class="badge" style="font-size:0.6rem;margin-right:0.2rem">${item.topic}</span>` : ''}
            ${item.tags ? html`<span style="opacity:0.7">${item.tags}</span>` : ''}
          </div>
        ` : ''}
      </div>
      ${statusBadge}
    </div>
  `
}

function renderAnalyzed(analyzed: any, timestamp: string, reviewItems: FactReviewItem[], t: TFunc) {
  const { facts, decisions, tasks } = analyzed
  const hasData = (facts?.length || decisions?.length || tasks?.length)
  if (!hasData) return ''

  const allItems = [
    ...(facts ?? []).map((f: any, i: number) => renderFactItem(f, '💡', timestamp, 'fact', i, reviewItems)),
    ...(decisions ?? []).map((d: any, i: number) => renderFactItem(d, '✅', timestamp, 'decision', i, reviewItems)),
    ...(tasks ?? []).map((tk: any, i: number) => renderFactItem(tk, '📌', timestamp, 'task', i, reviewItems)),
  ]

  return html`
    <div style="margin-top:0.4rem;border-top:1px solid var(--mc-border);padding-top:0.25rem">
      ${allItems}
    </div>
  `
}

// POST /records/retranscribe -- proxy to receiver's /retranscribe
app.post('/records/retranscribe', async (c) => {
  try {
    const body = await c.req.json()
    const { date, file, language } = body
    if (!date || !file) return c.json({ error: 'date and file required' }, 400)

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 120_000) // 2 min timeout for transcription
    const res = await fetch('http://localhost:3847/retranscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, file, language: language || 'auto' }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)

    const data = await res.json() as any
    return c.json(data, res.status as any)
  } catch (e) {
    return c.json({ error: 'Receiver offline / timeout' }, 502)
  }
})

// POST /records/reanalyze -- analyze transcript directly (no receiver needed)
app.post('/records/reanalyze', async (c) => {
  try {
    const body = await c.req.json()
    const { date, file } = body
    if (!date || !file) return c.json({ error: 'date and file required' }, 400)

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'Invalid date' }, 400)

    const baseName = file.replace(/\.(json|ogg|wav)$/, '')
    const transcriptPath = join(DATA_DIR, 'transcripts', date, `${baseName}.json`)
    const transcript = safeReadJson(transcriptPath)
    if (!transcript?.text) return c.json({ error: 'Transcript not found or empty' }, 404)

    // Clean hallucinations and save cleaned transcript
    const cleanedText = cleanWhisperHallucinations(transcript.text)
    if (cleanedText !== transcript.text) {
      transcript.text = cleanedText
      writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2))
    }
    if (!cleanedText || cleanedText.length < 5) return c.json({ ok: true, facts: 0, message: 'Empty after cleaning' })

    const analysis = await analyzeTranscript(cleanedText)

    // Save analysis
    const analyzedDir = join(DATA_DIR, 'analyzed', date)
    if (!existsSync(analyzedDir)) mkdirSync(analyzedDir, { recursive: true })
    writeFileSync(
      join(analyzedDir, `${baseName}.json`),
      JSON.stringify({ ...transcript, ...analysis }, null, 2)
    )

    // Collect new facts into review queue
    collectPendingFacts()

    const total = (analysis.facts?.length ?? 0) + (analysis.decisions?.length ?? 0) + (analysis.tasks?.length ?? 0)
    return c.json({ ok: true, facts: total, analysis })
  } catch (e) {
    console.error('Reanalyze error:', e)
    return c.json({ error: 'Analysis failed' }, 500)
  }
})

// POST /records/reanalyze-day -- analyze all chunks for a day as one text
app.post('/records/reanalyze-day', async (c) => {
  try {
    const body = await c.req.json()
    const { date } = body
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'valid date required' }, 400)

    const transcriptsDir = join(DATA_DIR, 'transcripts', date)
    const files = safeFileList(transcriptsDir, '.json')
    if (files.length === 0) return c.json({ error: 'No transcripts for this date' }, 404)

    // Combine all transcripts with timestamps
    const parts: string[] = []
    for (const file of files) {
      const filePath = join(transcriptsDir, file)
      const data = safeReadJson(filePath)
      if (!data?.text) continue
      // Clean hallucinations and save
      const cleaned = cleanWhisperHallucinations(data.text)
      if (cleaned !== data.text) {
        data.text = cleaned
        writeFileSync(filePath, JSON.stringify(data, null, 2))
      }
      if (!cleaned || cleaned.length < 5) continue
      const time = (data.timestamp ?? '').replace(/T(\d{2})-(\d{2}).*/, '$1:$2')
      parts.push(`[${time}] ${cleaned}`)
    }
    if (parts.length === 0) return c.json({ error: 'All transcripts empty' }, 404)

    const combinedText = parts.join('\n\n')
    const analysis = await analyzeTranscript(combinedText)

    // Save as a day-level analysis file
    const analyzedDir = join(DATA_DIR, 'analyzed', date)
    if (!existsSync(analyzedDir)) mkdirSync(analyzedDir, { recursive: true })
    writeFileSync(
      join(analyzedDir, `${date}-day.json`),
      JSON.stringify({ timestamp: `${date}T00-00-00`, device: 'all', text: combinedText, ...analysis }, null, 2)
    )

    collectPendingFacts()
    const total = (analysis.facts?.length ?? 0) + (analysis.decisions?.length ?? 0) + (analysis.tasks?.length ?? 0)
    return c.json({ ok: true, facts: total, analysis })
  } catch (e) {
    console.error('Reanalyze-day error:', e)
    return c.json({ error: 'Analysis failed' }, 500)
  }
})

// POST /records/review-fact -- approve/decline a fact from admin
app.post('/records/review-fact', async (c) => {
  try {
    const body = await c.req.json()
    const { id, status, bot } = body
    if (!id || !['approved', 'declined'].includes(status)) {
      return c.json({ error: 'id and status (approved/declined) required' }, 400)
    }
    const item = reviewFact(id, status)
    if (!item) return c.json({ error: 'Fact not found' }, 404)

    // On approve — insert fact into bot's DB with full procedure
    if (status === 'approved' && bot) {
      const botEnv = readEnv(bot)
      const chatId = botEnv['ALLOWED_CHAT_ID']?.split(',')[0]?.trim() || 'admin'
      const sector = item.type === 'fact' ? 'semantic' as const : 'episodic' as const
      const importance = item.type === 'task' ? 0.7 : item.type === 'decision' ? 0.6 : 0.5
      const topic = item.topic || item.topics[0] || 'general'
      const tags = item.tags ? `${item.tags},${item.device},listener` : [...item.topics, item.device, 'listener'].join(',')
      const timePrefix = item.timestamp.replace(/T(\d{2})-(\d{2}).*/, ' $1:$2')
      const content = `[${timePrefix}] ${item.content}`
      const factId = insertFactForBot(bot, chatId, content, topic, sector, tags, 'listener', importance)
      return c.json({ ok: true, status: item.status, factId, bot })
    }

    return c.json({ ok: true, status: item.status })
  } catch (e) {
    console.error('Review-fact error:', e)
    return c.json({ error: 'Review failed' }, 500)
  }
})

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
