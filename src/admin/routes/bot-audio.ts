import { readFileSync, unlinkSync } from 'fs'
import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout } from '../views/layout.js'
import { alert } from '../views/components.js'
import { readRootEnv, updateRootEnvKeys } from '../env-parser.js'
import {
  adminListKeys, adminAddKey, adminDeleteKey, adminSetActive,
  adminListVoices, adminReconcile, hasActiveKey,
} from '../../tts-providers/elevenlabs.js'
import {
  listKeysRedacted as groqListKeys, addKey as groqAddKey, deleteKey as groqDeleteKey,
  setEnabled as groqSetEnabled, resetKey as groqResetKey, validateKey as groqValidateKey,
  type RedactedGroqKey,
} from '../../groq-keys.js'
import { logger } from '../../logger.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

// Curated Edge TTS voices per language. Full Microsoft catalog has 100+ voices,
// these are the most common Neural ones for uk/ru/en that produce natural speech.
const EDGE_VOICES: Record<'uk' | 'ru' | 'en', { id: string; label: string }[]> = {
  uk: [
    { id: 'uk-UA-OstapNeural',   label: 'Ostap (M)' },
    { id: 'uk-UA-PolinaNeural',  label: 'Polina (F)' },
  ],
  ru: [
    { id: 'ru-RU-DmitryNeural',    label: 'Dmitry (M)' },
    { id: 'ru-RU-SvetlanaNeural',  label: 'Svetlana (F)' },
  ],
  en: [
    { id: 'en-US-AndrewNeural',  label: 'Andrew (M, US)' },
    { id: 'en-US-BrianNeural',   label: 'Brian (M, US)' },
    { id: 'en-US-AriaNeural',    label: 'Aria (F, US)' },
    { id: 'en-US-EmmaNeural',    label: 'Emma (F, US)' },
    { id: 'en-GB-RyanNeural',    label: 'Ryan (M, UK)' },
    { id: 'en-GB-SoniaNeural',   label: 'Sonia (F, UK)' },
  ],
}
const EDGE_DEFAULTS: Record<'uk' | 'ru' | 'en', string> = {
  uk: 'uk-UA-OstapNeural',
  ru: 'ru-RU-DmitryNeural',
  en: 'en-US-AndrewNeural',
}

// Gemini TTS prebuilt voices (30, multilingual — same voice speaks any language).
// Gender per AI Studio, characteristics translated from the official docs.
const GEMINI_VOICES: { id: string; label: string }[] = [
  { id: 'Zephyr', label: 'Zephyr (Ж) — яскравий' },
  { id: 'Puck', label: 'Puck (Ч) — бадьорий' },
  { id: 'Charon', label: 'Charon (Ч) — інформативний' },
  { id: 'Kore', label: 'Kore (Ж) — впевнений' },
  { id: 'Fenrir', label: 'Fenrir (Ч) — запальний' },
  { id: 'Leda', label: 'Leda (Ж) — юний' },
  { id: 'Orus', label: 'Orus (Ч) — впевнений' },
  { id: 'Aoede', label: 'Aoede (Ж) — легкий' },
  { id: 'Callirrhoe', label: 'Callirrhoe (Ж) — невимушений' },
  { id: 'Autonoe', label: 'Autonoe (Ж) — яскравий' },
  { id: 'Enceladus', label: 'Enceladus (Ч) — з придихом' },
  { id: 'Iapetus', label: 'Iapetus (Ч) — чистий' },
  { id: 'Umbriel', label: 'Umbriel (Ч) — невимушений' },
  { id: 'Algieba', label: 'Algieba (Ч) — плавний' },
  { id: 'Despina', label: 'Despina (Ж) — плавний' },
  { id: 'Erinome', label: 'Erinome (Ж) — чистий' },
  { id: 'Algenib', label: 'Algenib (Ч) — хриплуватий' },
  { id: 'Rasalgethi', label: 'Rasalgethi (Ч) — інформативний' },
  { id: 'Laomedeia', label: 'Laomedeia (Ж) — бадьорий' },
  { id: 'Achernar', label: 'Achernar (Ж) — м\'який' },
  { id: 'Alnilam', label: 'Alnilam (Ч) — впевнений' },
  { id: 'Schedar', label: 'Schedar (Ч) — рівний' },
  { id: 'Gacrux', label: 'Gacrux (Ж) — зрілий' },
  { id: 'Pulcherrima', label: 'Pulcherrima (Ж) — напористий' },
  { id: 'Achird', label: 'Achird (Ч) — дружній' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi (Ч) — розмовний' },
  { id: 'Vindemiatrix', label: 'Vindemiatrix (Ж) — лагідний' },
  { id: 'Sadachbia', label: 'Sadachbia (Ч) — жвавий' },
  { id: 'Sadaltager', label: 'Sadaltager (Ч) — експертний' },
  { id: 'Sulafat', label: 'Sulafat (Ж) — теплий' },
]

const app = new Hono<I18nEnv>()

// --- Page ---

app.get('/audio', async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const env = readRootEnv()
  const legacy = env['TTS_PROVIDER'] ?? 'gemini'
  const providerReply = (env['TTS_PROVIDER_REPLY'] ?? legacy) as 'edge' | 'elevenlabs' | 'gemini' | 'auto'
  const providerTool  = (env['TTS_PROVIDER_TOOL']  ?? legacy) as 'edge' | 'elevenlabs' | 'gemini' | 'auto'

  // Pre-load voices server-side if we have an active key, so <select>s are in
  // the initial DOM when htmx binds the form submit.
  let voicesHtml: ReturnType<typeof html> | string = ''
  if (hasActiveKey()) {
    try {
      const voices = await adminListVoices()
      const picker = (field: string, current: string) => html`
        <label style="margin:0;font-size:0.75rem">${field.toUpperCase()}
          <select name="voice_${field}" style="width:100%">
            <option value="">— (Edge)</option>
            ${voices.map(v => html`<option value="${v.voice_id}" ${v.voice_id === current ? 'selected' : ''}>${v.name}</option>`)}
          </select>
        </label>
      `
      voicesHtml = html`
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0.5rem">
          ${picker('uk', env['TTS_VOICE_UK'] ?? '')}
          ${picker('ru', env['TTS_VOICE_RU'] ?? '')}
          ${picker('en', env['TTS_VOICE_EN'] ?? '')}
        </div>
      `
    } catch (err) {
      voicesHtml = html`<p style="color:#c33;font-size:0.85rem">${(err as Error).message}</p>`
    }
  } else {
    voicesHtml = html`<p style="color:var(--mc-text-dim);font-size:0.85rem">${t('audio.addKeyForVoices')}</p>`
  }

  const content = html`
    <div class="section-header">
      <h3 style="margin:0">🔊 ${t('audio.title')}</h3>
      <small style="color:var(--mc-text-dim)">${t('audio.sharedNote')}</small>
    </div>
    <div id="audio-alerts"></div>

    <!-- A0. Groq STT keys -->
    <details open style="margin-bottom:1rem;border:1px solid var(--mc-border);border-radius:6px;padding:0.75rem">
      <summary style="cursor:pointer;font-weight:600">🎧 Groq STT ${t('audio.groqKeys')}</summary>
      <div style="margin-top:0.75rem">
        <p style="color:var(--mc-text-dim);font-size:0.85rem;margin:0 0 0.5rem">${t('audio.groqHint')}</p>
        <div id="groq-keys-table" hx-get="/audio/groq-keys" hx-trigger="load" hx-swap="innerHTML">${t('audio.loading')}</div>
        <form hx-post="/audio/groq-keys" hx-target="#groq-keys-table" hx-swap="innerHTML" style="margin-top:0.75rem"
              hx-on::after-request="if(event.detail.xhr.status<400){this.reset();}">
          <div class="grid">
            <label>${t('audio.keyLabel')}<input type="text" name="label" placeholder="primary" autocomplete="off"></label>
            <label>${t('audio.keyValue')}<input type="password" name="key" required autocomplete="off"></label>
          </div>
          <div style="margin-top:0.5rem;display:flex;gap:0.5rem">
            <button type="submit">${t('audio.addKey')}</button>
          </div>
        </form>
      </div>
    </details>

    <!-- A. ElevenLabs Keys -->
    <details open style="margin-bottom:1rem;border:1px solid var(--mc-border);border-radius:6px;padding:0.75rem">
      <summary style="cursor:pointer;font-weight:600">🔑 ElevenLabs ${t('audio.keys')}</summary>
      <div style="margin-top:0.75rem">
        <p style="color:var(--mc-text-dim);font-size:0.85rem;margin:0 0 0.5rem">${t('audio.directCallsNote')}</p>
        <div id="keys-table" hx-get="/audio/keys" hx-trigger="load" hx-swap="innerHTML">${t('audio.loading')}</div>
        <form hx-post="/audio/keys" hx-target="#keys-table" hx-swap="innerHTML" style="margin-top:0.75rem"
              hx-on::after-request="if(event.detail.xhr.status<400){this.reset();}">
          <div class="grid">
            <label>${t('audio.keyLabel')}<input type="text" name="label" placeholder="main" required autocomplete="off"></label>
            <label>${t('audio.keyValue')}<input type="password" name="key" required autocomplete="off"></label>
          </div>
          <div style="margin-top:0.5rem;display:flex;gap:0.5rem">
            <button type="submit">${t('audio.addKey')}</button>
            <button type="button" hx-post="/audio/reconcile" hx-target="#keys-table">${t('audio.reconcile')}</button>
          </div>
        </form>
      </div>
    </details>

    <!-- B. Strategy & parameters -->
    <details open style="margin-bottom:1rem;border:1px solid var(--mc-border);border-radius:6px;padding:0.75rem">
      <summary style="cursor:pointer;font-weight:600">⚙️ ${t('audio.strategy')}</summary>
      <form hx-post="/audio/settings" hx-target="#audio-alerts" hx-swap="innerHTML" style="margin-top:0.75rem">
        ${(() => {
          const compactRadio = (group: string, val: string, current: string, label: string) => html`
            <label style="display:inline-flex;align-items:center;gap:0.3rem;cursor:pointer;margin:0;font-weight:normal">
              <input type="radio" name="${group}" value="${val}" ${current === val ? 'checked' : ''} style="margin:0;width:auto">${label}
            </label>
          `
          return html`
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.75rem 1.5rem;margin-bottom:0.75rem">
              <div>
                <div style="font-weight:600;font-size:0.8rem;margin-bottom:0.3rem">${t('audio.providerReply')}</div>
                <div style="display:flex;flex-direction:column;gap:0.25rem">
                  ${compactRadio('provider_reply', 'gemini',     providerReply, 'Gemini')}
                  ${compactRadio('provider_reply', 'edge',       providerReply, 'Edge')}
                  ${compactRadio('provider_reply', 'elevenlabs', providerReply, 'ElevenLabs')}
                  ${compactRadio('provider_reply', 'auto',       providerReply, 'Auto')}
                </div>
              </div>
              <div>
                <div style="font-weight:600;font-size:0.8rem;margin-bottom:0.3rem">${t('audio.providerTool')}</div>
                <div style="display:flex;flex-direction:column;gap:0.25rem">
                  ${compactRadio('provider_tool', 'gemini',     providerTool, 'Gemini')}
                  ${compactRadio('provider_tool', 'edge',       providerTool, 'Edge')}
                  ${compactRadio('provider_tool', 'elevenlabs', providerTool, 'ElevenLabs')}
                  ${compactRadio('provider_tool', 'auto',       providerTool, 'Auto')}
                </div>
              </div>
            </div>
            <div style="font-size:0.7rem;color:var(--mc-text-dim);margin-bottom:0.75rem">Gemini — безкоштовно, виразний, fallback на Edge · Edge — безкоштовно · ElevenLabs — кредити · Auto — ElevenLabs з fallback на Gemini/Edge</div>
          `
        })()}

        <hr style="border:none;border-top:1px solid var(--mc-border);margin:0.75rem 0">

        <!-- Edge subsection — voices in row + rate inline -->
        <div style="display:flex;align-items:baseline;gap:0.5rem;margin-bottom:0.4rem">
          <span style="font-weight:600">🤖 Edge</span>
          <span style="font-size:0.7rem;color:var(--mc-text-dim)">${t('audio.edgeRateHint')}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.5rem;margin-bottom:0.75rem">
          ${(['uk','ru','en'] as const).map(L => {
            const current = env[`TTS_VOICE_EDGE_${L.toUpperCase()}`] || EDGE_DEFAULTS[L]
            return html`
              <label style="margin:0;font-size:0.75rem">${L.toUpperCase()}
                <select name="voice_edge_${L}" style="width:100%">
                  ${EDGE_VOICES[L].map(v => html`<option value="${v.id}" ${v.id === current ? 'selected' : ''}>${v.label}</option>`)}
                </select>
              </label>
            `
          })}
          <label style="margin:0;font-size:0.75rem">${t('audio.edgeRate')}
            <input type="text" name="edge_rate" value="${env['TTS_RATE'] ?? '+30%'}" placeholder="+30%" style="width:100%">
          </label>
        </div>

        <hr style="border:none;border-top:1px solid var(--mc-border);margin:0.75rem 0">

        <!-- Gemini subsection -->
        <div style="font-weight:600;margin-bottom:0.4rem">✨ Gemini</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.5rem 1rem;margin-bottom:0.75rem">
          <label style="margin:0;font-size:0.75rem">${t('audio.geminiVoice')}
            <select name="gemini_voice" style="width:100%">
              ${GEMINI_VOICES.map(v => html`<option value="${v.id}" ${v.id === (env['TTS_VOICE_GEMINI'] ?? 'Charon') ? 'selected' : ''}>${v.label}</option>`)}
            </select>
          </label>
          <label style="margin:0;font-size:0.75rem" title="${t('audio.geminiStyleHint')}">${t('audio.geminiStyle')}
            <input type="text" name="gemini_style" value="${env['TTS_GEMINI_STYLE'] ?? ''}" placeholder="Говори тепло і спокійно:" style="width:100%">
          </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:0.5rem;align-items:end;margin-bottom:0.5rem">
          <label style="margin:0;font-size:0.75rem">${t('audio.geminiPreviewText')}
            <input type="text" name="preview_text" value="Привіт! Це перевірка голосу для БотВи. Як тобі звучання?" maxlength="300" style="width:100%">
          </label>
          <button type="button"
            hx-post="/audio/gemini-preview" hx-include="closest form" hx-target="#gemini-preview-result" hx-swap="innerHTML"
            hx-indicator="#gemini-preview-spinner"
            style="white-space:nowrap">▶ ${t('audio.geminiPreview')}</button>
        </div>
        <div id="gemini-preview-spinner" class="htmx-indicator" style="font-size:0.75rem;color:var(--mc-text-dim)">${t('audio.geminiPreviewWait')}</div>
        <div id="gemini-preview-result" style="margin-bottom:0.75rem"></div>

        <hr style="border:none;border-top:1px solid var(--mc-border);margin:0.75rem 0">

        <!-- ElevenLabs subsection -->
        <div style="font-weight:600;margin-bottom:0.4rem">🎙 ElevenLabs</div>
        <div id="voice-pickers" style="margin-bottom:0.5rem">${voicesHtml}</div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.5rem 1rem;align-items:end">
          <label style="margin:0;font-size:0.75rem;grid-column:1 / -1">${t('audio.model')}
            <select name="model_id" style="width:100%">
              <option value="eleven_multilingual_v2" ${(env['TTS_MODEL_ID'] ?? 'eleven_multilingual_v2') === 'eleven_multilingual_v2' ? 'selected' : ''}>eleven_multilingual_v2</option>
              <option value="eleven_turbo_v2_5" ${env['TTS_MODEL_ID'] === 'eleven_turbo_v2_5' ? 'selected' : ''}>eleven_turbo_v2_5 (faster, cheaper)</option>
              <option value="eleven_flash_v2_5" ${env['TTS_MODEL_ID'] === 'eleven_flash_v2_5' ? 'selected' : ''}>eleven_flash_v2_5 (fastest)</option>
            </select>
          </label>
          ${(() => {
            const slider = (name: string, label: string, value: string, min: string, max: string, step: string, hint: string) => html`
              <label style="margin:0;font-size:0.75rem" title="${hint}">
                <div style="display:flex;justify-content:space-between;align-items:baseline">
                  <span>${label}</span>
                  <output style="font-family:monospace;font-size:0.7rem;color:var(--mc-text-dim)">${value}</output>
                </div>
                <input type="range" name="${name}" min="${min}" max="${max}" step="${step}" value="${value}"
                  oninput="this.parentElement.querySelector('output').textContent=this.value" style="width:100%;margin:0">
              </label>
            `
            return html`
              ${slider('el_speed',      t('audio.elSpeed'),      env['TTS_EL_SPEED']      ?? '1.0',  '0.7', '1.2', '0.05', t('audio.elSpeedHint'))}
              ${slider('el_stability',  t('audio.elStability'),  env['TTS_EL_STABILITY']  ?? '0.6',  '0',   '1',   '0.05', t('audio.elStabilityHint'))}
              ${slider('el_similarity', t('audio.elSimilarity'), env['TTS_EL_SIMILARITY'] ?? '0.75', '0',   '1',   '0.05', t('audio.elSimilarityHint'))}
              ${slider('el_style',      t('audio.elStyle'),      env['TTS_EL_STYLE']      ?? '0',    '0',   '1',   '0.05', t('audio.elStyleHint'))}
            `
          })()}
        </div>

        <button type="submit" style="margin-top:0.75rem">${t('audio.save')}</button>
      </form>
    </details>
  `
  return c.html(layout(t('audio.title'), content, '/audio', t, lang, 'volume-2'))
})

// --- Keys table render ---

function renderKeysTable(t: TFunc, keys: ReturnType<typeof adminListKeys>) {
  if (keys.length === 0) {
    return html`<p style="color:var(--mc-text-dim)">${t('audio.noKeys')}</p>`
  }
  const totalRem = keys.reduce((s, k) => s + Math.max(0, (k.limit || 0) - (k.used || 0)), 0)
  const totalLim = keys.reduce((s, k) => s + (k.limit || 0), 0)
  return html`
    <div style="font-size:0.8rem;color:var(--mc-text-dim);margin-bottom:0.5rem">${t('audio.totalRemaining')}: ${totalRem.toLocaleString()} / ${totalLim.toLocaleString()} chars</div>
    <div class="table-wrap"><table>
      <thead><tr><th style="width:1%;white-space:nowrap"></th><th>${t('audio.keyLabel')}</th><th>Used</th><th>Limit</th><th>%</th><th>${t('audio.status')}</th><th style="width:1%"></th></tr></thead>
      <tbody>
        ${keys.map(k => {
          const pct = k.limit > 0 ? Math.round((k.used / k.limit) * 100) : 0
          return html`
            <tr>
              <td style="width:1%;text-align:center;padding-right:0">
                <input type="radio" name="active-key" ${k.active ? 'checked' : ''}
                  hx-post="/audio/keys/${k.id}/activate" hx-target="#keys-table" hx-swap="innerHTML"
                  title="${t('audio.makeActive')}" style="margin:0;width:auto">
              </td>
              <td>${k.label}<br><small style="color:var(--mc-text-dim)">${k.key_preview}</small></td>
              <td>${k.used.toLocaleString()}</td>
              <td>${k.limit.toLocaleString()}</td>
              <td>${pct}%</td>
              <td>${k.last_error ? html`<span style="color:#c33" title="${k.last_error}">⚠</span>` : html`<span style="color:#0a0">●</span>`}</td>
              <td><button class="danger btn-sm" hx-delete="/audio/keys/${k.id}" hx-target="#keys-table" hx-swap="innerHTML" hx-confirm="Delete key ${k.label}?">✕</button></td>
            </tr>
          `
        })}
      </tbody>
    </table></div>
  `
}

// --- Groq keys table ---

function fmtSeconds(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h}h ${m}m`
}

function fmtCountdown(untilMs: number): string {
  const diff = Math.max(0, untilMs - Date.now())
  const sec = Math.floor(diff / 1000)
  return fmtSeconds(sec)
}

function renderGroqKeysTable(t: TFunc, keys: RedactedGroqKey[]) {
  if (keys.length === 0) {
    return html`<p style="color:var(--mc-text-dim)">${t('audio.noKeys')}</p>`
  }
  const now = Date.now()
  const usableLimit = keys.filter(k => k.enabled).reduce((s, k) => s + k.limit_seconds, 0)
  const usableUsed  = keys.filter(k => k.enabled).reduce((s, k) => s + k.used_seconds, 0)
  return html`
    <div style="font-size:0.8rem;color:var(--mc-text-dim);margin-bottom:0.5rem">
      ${t('audio.groqUsedHour')}: ${fmtSeconds(usableUsed)} / ${fmtSeconds(usableLimit)}
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th style="width:1%"></th>
        <th>${t('audio.keyLabel')}</th>
        <th>${t('audio.groqWindow')}</th>
        <th>${t('audio.groqLifetime')}</th>
        <th>${t('audio.status')}</th>
        <th style="width:1%"></th>
      </tr></thead>
      <tbody>
        ${keys.map(k => {
          const pct = k.limit_seconds > 0 ? Math.round((k.used_seconds / k.limit_seconds) * 100) : 0
          const rl = k.rate_limited_until && k.rate_limited_until > now
          const status = !k.enabled
            ? html`<span style="color:#888" title="disabled">○</span>`
            : rl
              ? html`<span style="color:#c33" title="${k.last_error ?? ''}">⏸ ${fmtCountdown(k.rate_limited_until!)}</span>`
              : k.last_error
                ? html`<span style="color:#c80" title="${k.last_error}">⚠</span>`
                : html`<span style="color:#0a0">●</span>`
          return html`
            <tr>
              <td style="text-align:center;padding-right:0">
                <input type="checkbox" ${k.enabled ? 'checked' : ''}
                  hx-post="/audio/groq-keys/${k.id}/toggle" hx-target="#groq-keys-table" hx-swap="innerHTML"
                  title="${t('audio.groqToggle')}" style="margin:0;width:auto">
              </td>
              <td>${k.label}<br><small style="color:var(--mc-text-dim)">${k.key_preview}</small></td>
              <td>${fmtSeconds(k.used_seconds)} / ${fmtSeconds(k.limit_seconds)} (${pct}%)</td>
              <td>${fmtSeconds(k.total_seconds)} · ${k.total_requests} req</td>
              <td>${status}</td>
              <td style="white-space:nowrap">
                ${rl || k.last_error ? html`<button class="btn-sm" hx-post="/audio/groq-keys/${k.id}/reset" hx-target="#groq-keys-table" hx-swap="innerHTML" title="${t('audio.groqReset')}">↻</button>` : ''}
                <button class="danger btn-sm" hx-delete="/audio/groq-keys/${k.id}" hx-target="#groq-keys-table" hx-swap="innerHTML" hx-confirm="Delete key ${k.label}?">✕</button>
              </td>
            </tr>
          `
        })}
      </tbody>
    </table></div>
  `
}

// --- Groq keys endpoints ---

app.get('/audio/groq-keys', (c) => {
  const t: TFunc = c.get('t')
  try {
    return c.html(renderGroqKeysTable(t, groqListKeys()))
  } catch (err) {
    return c.html(html`<p style="color:#c33">${(err as Error).message}</p>`)
  }
})

app.post('/audio/groq-keys', async (c) => {
  const t: TFunc = c.get('t')
  const body = await c.req.parseBody()
  const key = String(body['key'] ?? '').trim()
  const label = String(body['label'] ?? '').trim() || 'key'
  try {
    // Validate by hitting Groq's /models — confirms the key exists and auth works.
    await groqValidateKey(key)
    groqAddKey(key, label)
    return c.html(renderGroqKeysTable(t, groqListKeys()))
  } catch (err) {
    return c.html(html`<p style="color:#c33">${(err as Error).message}</p>`)
  }
})

app.delete('/audio/groq-keys/:id', (c) => {
  const t: TFunc = c.get('t')
  try {
    groqDeleteKey(c.req.param('id')!)
    return c.html(renderGroqKeysTable(t, groqListKeys()))
  } catch (err) {
    return c.html(html`<p style="color:#c33">${(err as Error).message}</p>`)
  }
})

app.post('/audio/groq-keys/:id/reset', (c) => {
  const t: TFunc = c.get('t')
  try {
    groqResetKey(c.req.param('id')!)
    return c.html(renderGroqKeysTable(t, groqListKeys()))
  } catch (err) {
    return c.html(html`<p style="color:#c33">${(err as Error).message}</p>`)
  }
})

app.post('/audio/groq-keys/:id/toggle', (c) => {
  const t: TFunc = c.get('t')
  const id = c.req.param('id')!
  const list = groqListKeys()
  const cur = list.find(k => k.id === id)
  if (cur) groqSetEnabled(id, !cur.enabled)
  return c.html(renderGroqKeysTable(t, groqListKeys()))
})

// --- ElevenLabs keys endpoints ---

app.get('/audio/keys', (c) => {
  const t: TFunc = c.get('t')
  try {
    return c.html(renderKeysTable(t, adminListKeys()))
  } catch (err) {
    return c.html(html`<p style="color:#c33">${(err as Error).message}</p>`)
  }
})

app.post('/audio/keys', async (c) => {
  const t: TFunc = c.get('t')
  const body = await c.req.parseBody()
  const key = String(body['key'] ?? '').trim()
  const label = String(body['label'] ?? '').trim() || 'key'
  try {
    await adminAddKey(key, label)
    return c.html(renderKeysTable(t, adminListKeys()))
  } catch (err) {
    return c.html(html`<p style="color:#c33">${(err as Error).message}</p>`)
  }
})

app.delete('/audio/keys/:id', (c) => {
  const t: TFunc = c.get('t')
  const id = c.req.param('id')!
  try {
    adminDeleteKey(id)
    return c.html(renderKeysTable(t, adminListKeys()))
  } catch (err) {
    return c.html(html`<p style="color:#c33">${(err as Error).message}</p>`)
  }
})

app.post('/audio/keys/:id/activate', (c) => {
  const t: TFunc = c.get('t')
  const id = c.req.param('id')!
  try {
    adminSetActive(id)
    return c.html(renderKeysTable(t, adminListKeys()))
  } catch (err) {
    return c.html(html`<p style="color:#c33">${(err as Error).message}</p>`)
  }
})

app.post('/audio/reconcile', async (c) => {
  const t: TFunc = c.get('t')
  try {
    await adminReconcile()
    return c.html(renderKeysTable(t, adminListKeys()))
  } catch (err) {
    return c.html(html`<p style="color:#c33">${(err as Error).message}</p>`)
  }
})

// --- Gemini voice preview ---

app.post('/audio/gemini-preview', async (c) => {
  const t: TFunc = c.get('t')
  const body = await c.req.parseBody()
  const voice = String(body['gemini_voice'] ?? '').trim()
  const style = String(body['gemini_style'] ?? '').trim()
  const text = String(body['preview_text'] ?? '').trim().slice(0, 300)
  if (!text) return c.html(html`<p style="color:#c33;font-size:0.85rem">${t('audio.geminiPreviewNoText')}</p>`)
  try {
    const { synthGemini } = await import('../../tts-providers/gemini.js')
    const path = await synthGemini(text, undefined, { voice, style })
    const buf = readFileSync(path)
    try { unlinkSync(path) } catch { /* ignore */ }
    const mime = path.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav'
    return c.html(html`
      <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
        <audio controls autoplay src="data:${mime};base64,${buf.toString('base64')}" style="height:32px"></audio>
        <small style="color:var(--mc-text-dim)">${voice}${style ? html` · «${style}»` : ''}</small>
      </div>
    `)
  } catch (err) {
    return c.html(html`<p style="color:#c33;font-size:0.85rem">${(err as Error).message}</p>`)
  }
})

// --- Save settings ---

app.post('/audio/settings', async (c) => {
  const t: TFunc = c.get('t')
  const body = await c.req.parseBody()
  const updates: Record<string, string> = {
    TTS_PROVIDER_REPLY: String(body['provider_reply'] ?? 'gemini'),
    TTS_PROVIDER_TOOL:  String(body['provider_tool']  ?? 'gemini'),
    // Clear legacy single var to avoid stale fallback
    TTS_PROVIDER: '',
    // Gemini
    TTS_VOICE_GEMINI:  String(body['gemini_voice'] ?? ''),
    TTS_GEMINI_STYLE:  String(body['gemini_style'] ?? ''),
    // Edge
    TTS_VOICE_EDGE_UK: String(body['voice_edge_uk'] ?? ''),
    TTS_VOICE_EDGE_RU: String(body['voice_edge_ru'] ?? ''),
    TTS_VOICE_EDGE_EN: String(body['voice_edge_en'] ?? ''),
    TTS_RATE:          String(body['edge_rate']     ?? '+30%'),
    // ElevenLabs
    TTS_MODEL_ID:      String(body['model_id']  ?? 'eleven_multilingual_v2'),
    TTS_VOICE_UK:      String(body['voice_uk']  ?? ''),
    TTS_VOICE_RU:      String(body['voice_ru']  ?? ''),
    TTS_VOICE_EN:      String(body['voice_en']  ?? ''),
    TTS_EL_SPEED:      String(body['el_speed']      ?? '1.0'),
    TTS_EL_STABILITY:  String(body['el_stability']  ?? '0.6'),
    TTS_EL_SIMILARITY: String(body['el_similarity'] ?? '0.75'),
    TTS_EL_STYLE:      String(body['el_style']      ?? '0'),
  }
  updateRootEnvKeys(updates)
  logger.info({ reply: updates.TTS_PROVIDER_REPLY, tool: updates.TTS_PROVIDER_TOOL, edge: { rate: updates.TTS_RATE }, el: { speed: updates.TTS_EL_SPEED, stability: updates.TTS_EL_STABILITY } }, 'audio settings saved')
  return c.html(html`
    ${alert('success', `${t('audio.saved')}`)}
    <script>setTimeout(() => location.reload(), 800)</script>
  `)
})

export default app
