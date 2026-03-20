import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { truncate, guideBlock } from '../views/components.js'
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
    const data = safeReadJson(join(transcriptsDir, filename))
    if (!data) return null

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
    ${guideBlock(t('guide.records.title'), [t('guide.records.1'), t('guide.records.2'), t('guide.records.3')])}

    <h3>${icon('radio')} Devices</h3>
    <div id="devices-status"
      hx-get="/records/devices-status"
      hx-trigger="load, every 30s"
      hx-swap="innerHTML">
      <span style="color:var(--mc-text-dim)">${icon('loader', 13)} Loading...</span>
    </div>

    <details style="margin-top:1.5rem;margin-bottom:1.5rem">
      <summary style="cursor:pointer;font-size:1rem;font-weight:600">${icon('plus-circle')} Add New Device</summary>
      <div style="background:var(--mc-bg-secondary);border:1px solid var(--mc-border);border-radius:8px;padding:1rem;margin-top:0.5rem">
        <p style="font-size:0.85rem;color:var(--mc-text-dim);margin-top:0">
          Deploy a room listener to any Linux device with a microphone (Orange Pi, Raspberry Pi, etc.)
        </p>

        <form id="setup-form" onsubmit="return false" style="display:flex;flex-direction:column;gap:0.75rem">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div>
              <label style="font-size:0.75rem;font-weight:500">SSH Target</label>
              <input id="sf-ssh" type="text" placeholder="user@device-ip" style="width:100%;padding:0.4rem 0.6rem;border:1px solid var(--mc-border);border-radius:6px;background:var(--mc-bg);color:var(--mc-text);font-size:0.85rem" />
            </div>
            <div>
              <label style="font-size:0.75rem;font-weight:500">Device ID</label>
              <input id="sf-device" type="text" placeholder="opi-livingroom" style="width:100%;padding:0.4rem 0.6rem;border:1px solid var(--mc-border);border-radius:6px;background:var(--mc-bg);color:var(--mc-text);font-size:0.85rem" />
            </div>
          </div>

          <details>
            <summary style="font-size:0.8rem;cursor:pointer;color:var(--mc-text-dim)">Advanced options</summary>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.5rem;margin-top:0.5rem">
              <div>
                <label style="font-size:0.7rem">Chunk duration (s)</label>
                <input id="sf-chunk" type="number" value="300" style="width:100%;padding:0.3rem 0.5rem;border:1px solid var(--mc-border);border-radius:6px;background:var(--mc-bg);color:var(--mc-text);font-size:0.8rem" />
              </div>
              <div>
                <label style="font-size:0.7rem">Overlap (s)</label>
                <input id="sf-overlap" type="number" value="10" style="width:100%;padding:0.3rem 0.5rem;border:1px solid var(--mc-border);border-radius:6px;background:var(--mc-bg);color:var(--mc-text);font-size:0.8rem" />
              </div>
              <div>
                <label style="font-size:0.7rem">tmpfs size (MB)</label>
                <input id="sf-tmpfs" type="number" value="100" style="width:100%;padding:0.3rem 0.5rem;border:1px solid var(--mc-border);border-radius:6px;background:var(--mc-bg);color:var(--mc-text);font-size:0.8rem" />
              </div>
            </div>
          </details>

          <div>
            <button type="button" onclick="generateSetupCmd()" class="btn-sm" style="padding:0.4rem 1rem;cursor:pointer">
              ${icon('terminal', 12)} Generate Setup Command
            </button>
          </div>
        </form>

        <div id="setup-output" style="display:none;margin-top:0.75rem">
          <label style="font-size:0.75rem;font-weight:500">Run this on your Mac/server:</label>
          <pre id="setup-cmd" style="background:var(--mc-surface2);border:1px solid var(--mc-border);border-radius:6px;padding:0.75rem;font-size:0.78rem;overflow-x:auto;cursor:pointer;position:relative" onclick="copyCmd(this)"></pre>
          <span id="copy-hint" style="font-size:0.7rem;color:var(--mc-text-dim)">Click to copy</span>
        </div>

        <div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--mc-border)">
          <details>
            <summary style="font-size:0.8rem;cursor:pointer;color:var(--mc-text-dim)">${icon('book', 11)} What the setup script does</summary>
            <div style="font-size:0.78rem;line-height:1.6;margin-top:0.5rem;color:var(--mc-text-secondary)">
              <ol style="padding-left:1.2rem;margin:0">
                <li>Detects audio hardware (ALSA card + mic)</li>
                <li>Sets up tmpfs for /data (no SD card writes for audio)</li>
                <li>Configures volatile journald + zram for /var/log</li>
                <li>Tunes kernel for minimal SD writes</li>
                <li>Creates Python venv + installs requests</li>
                <li>Deploys listener.py + config.env</li>
                <li>Creates systemd service (auto-start on boot)</li>
                <li>Installs safe shutdown/reboot scripts</li>
                <li>Boosts microphone gain to max</li>
                <li>Tests recording and starts the service</li>
              </ol>
              <p style="margin:0.5rem 0 0 0">
                <strong>LED indicators (Orange Pi):</strong> 🔴 recording &bull; 🔴🟢 blink = uploading &bull; 🟢 safe to power off
              </p>
              <p style="margin:0.25rem 0 0 0">
                <strong>Button (Orange Pi):</strong> press to force upload + safe shutdown mode
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
      document.getElementById('copy-hint').textContent = 'Copied!';
      setTimeout(() => { document.getElementById('copy-hint').textContent = 'Click to copy'; }, 2000);
    }
    </script>

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
  const totalAudio = totalDirSize(audioDir)

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
                >${icon('refresh-cw', 10)} Re-STT</button>
              </div>
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
    </script>
  `

  return c.html(layout(`Records: ${date}`, html`${content}${retranscribeScript}`, '/records', t, lang))
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
    return c.json({ error: 'Receiver offline or timeout' }, 502)
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
