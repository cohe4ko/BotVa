import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { alert } from '../views/components.js'
import { readEnvRaw, writeEnvRaw, writeRoleMd, readEnv } from '../env-parser.js'
import { getBotStatus, stopBot } from '../bot-control.js'
import { validateBot, botName } from '../bot-middleware.js'
import { getSettings, upsertSetting, getBotDir, getProjectRoot } from '../db-multi.js'
import { validateEnv, verifyTelegramToken } from '../env-validator.js'
import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { resolve } from 'path'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import { deleteBot, removeFromTeamJson, getAvailableRoles, buildRoleMd } from '../../bot-manager.js'
import { hasWorkspaceFiles, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, isWritableFile, isGlobalFile, buildWorkspaceFilesFromRole, splitRoleIntoWorkspaceFiles, createWorkspaceFiles, assembleFromWorkspaceFiles, refreshClaudeMd, type WorkspaceFileName } from '../../workspace-files.js'

import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer'

/**
 * Count tokens using Anthropic's tokenizer. Uses Claude 2 BPE — Claude 3+/4+
 * tokenizer is slightly different but close enough for UI previews (±5-8%).
 * For exact counts on modern Claude, use API messages.countTokens.
 */
function estimateTokens(s: string): number {
  if (!s) return 0
  try {
    return anthropicCountTokens(s)
  } catch {
    // Fallback heuristic if tokenizer fails: UA+markdown ~1.8 chars/token
    return Math.round(s.length / 1.8)
  }
}

/**
 * Compute Jaccard similarity (0..1) between two strings using line-based 4-grams.
 * Used to detect when a per-bot overlay file is mostly a copy of its global.
 */
function overlapRatio(a: string, b: string): number {
  if (!a || !b) return 0
  const grams = (s: string): Set<string> => {
    const lines = s.split('\n').map(l => l.trim()).filter(Boolean)
    const out = new Set<string>()
    for (let i = 0; i + 3 < lines.length; i++) {
      out.add(lines.slice(i, i + 4).join('\n'))
    }
    return out
  }
  const A = grams(a)
  const B = grams(b)
  if (A.size === 0 || B.size === 0) return 0
  let intersect = 0
  for (const g of A) if (B.has(g)) intersect++
  const union = A.size + B.size - intersect
  return union === 0 ? 0 : intersect / union
}
import { getRolesDir } from '../../bot-manager.js'

function getModelLabels(t: TFunc) {
  return [
    { id: 'fable', label: t('config.fableDesc') },
    { id: 'opus-1m', label: t('config.opus1mDesc') },
    { id: 'opus', label: t('config.opusDesc') },
    { id: 'sonnet-1m', label: t('config.sonnet1mDesc') },
    { id: 'sonnet', label: t('config.sonnetDesc') },
    { id: 'haiku', label: t('config.haikuDesc') },
  ]
}

const MODEL_IDS = ['fable', 'opus-1m', 'opus', 'sonnet-1m', 'sonnet', 'haiku']
const EFFORT_IDS = ['', 'low', 'medium', 'high', 'max']

function getAgentSettings(name: string): { model: string; backgroundModel: string; effort: string } {
  try {
    const settings = getSettings(name)
    const chatId = readEnv(name)['ALLOWED_CHAT_ID'] ?? ''
    const modelSetting = settings.find(s => s.key === 'model' && s.chat_id === chatId)
    const bgModelSetting = settings.find(s => s.key === 'background_model' && s.chat_id === chatId)
    const effortSetting = settings.find(s => s.key === 'effort' && s.chat_id === chatId)
    return {
      model: modelSetting?.value ?? 'sonnet',
      backgroundModel: bgModelSetting?.value ?? 'sonnet',
      effort: effortSetting?.value ?? '',
    }
  } catch {
    return { model: 'sonnet', backgroundModel: 'sonnet', effort: '' }
  }
}

const app = new Hono<I18nEnv>()

app.get('/bot/:name/config', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const envContent = readEnvRaw(name)
  const status = getBotStatus(name)
  const MODELS = getModelLabels(t)

  const agentSettings = getAgentSettings(name)

  const content = html`
    ${botNav(name, 'config', t)}
    <div id="config-alerts"></div>

    <h3 class="section-title">${icon('cpu')} ${t('config.agentSettings')}</h3>
    <form class="form-section" hx-post="/bot/${name}/config/agent" hx-target="#config-alerts" hx-swap="innerHTML">
      <div class="grid">
        <label>${t('config.model')}
          <select name="model" id="chat-model-select">
            ${MODELS.map(m => html`<option value="${m.id}" ${m.id === agentSettings.model ? 'selected' : ''}>${m.label}</option>`)}
          </select>
          <small>${t('config.modelHint')}</small>
        </label>
        <label>${t('config.effort')}
          <select name="effort" id="chat-effort-select">
            <option value="" ${agentSettings.effort === '' ? 'selected' : ''}>${t('config.effortDefault')}</option>
            <option value="low" ${agentSettings.effort === 'low' ? 'selected' : ''}>${t('config.effortLow')}</option>
            <option value="medium" ${agentSettings.effort === 'medium' ? 'selected' : ''}>${t('config.effortMedium')}</option>
            <option value="high" ${agentSettings.effort === 'high' ? 'selected' : ''}>${t('config.effortHigh')}</option>
            <option value="max" ${agentSettings.effort === 'max' ? 'selected' : ''} data-opus-only>${t('config.effortMax')}</option>
          </select>
          <small>${t('config.effortHint')}</small>
        </label>
        <label>${t('config.backgroundModel')}
          <select name="background_model">
            ${MODELS.map(m => html`<option value="${m.id}" ${m.id === agentSettings.backgroundModel ? 'selected' : ''}>${m.label}</option>`)}
          </select>
          <small>${t('config.backgroundModelHint')}</small>
        </label>
      </div>
      <button type="submit">${icon('save', 13)} ${t('config.saveAgent')}</button>
    </form>
    <script>
    (function() {
      const modelSel = document.getElementById('chat-model-select');
      const effortSel = document.getElementById('chat-effort-select');
      if (!modelSel || !effortSel) return;
      function syncMax() {
        const isOpus = modelSel.value.indexOf('opus') === 0;
        const maxOpt = effortSel.querySelector('option[data-opus-only]');
        if (!maxOpt) return;
        maxOpt.hidden = !isOpus;
        maxOpt.disabled = !isOpus;
        if (!isOpus && effortSel.value === 'max') effortSel.value = 'high';
      }
      modelSel.addEventListener('change', syncMax);
      syncMax();
    })();
    </script>

    <h3 class="section-title">${icon('file-key')} ${t('config.environment')}</h3>
    <form class="form-section" hx-post="/bot/${name}/config/env" hx-target="#config-alerts" hx-swap="innerHTML">
      <textarea name="env" class="code" rows="15">${envContent}</textarea>
      <div class="btn-group">
        <button type="submit">${icon('save', 13)} ${t('config.saveEnv')}</button>
        <button type="button" hx-post="/bot/${name}/config/verify-token" hx-target="#config-alerts" hx-swap="innerHTML" class="outline">${icon('shield-check', 13)} ${t('config.verifyToken')}</button>
        ${status.running ? html`<button type="button" hx-post="/bot/${name}/restart" hx-target="#config-alerts" hx-swap="innerHTML" class="contrast outline">${icon('refresh-cw', 13)} ${t('config.restartBot')}</button>` : ''}
      </div>
    </form>

    <h3 class="section-title">${icon('file-pen')} ${t('config.personality')}</h3>
    ${(() => {
      const roles = getAvailableRoles()
      if (roles.length === 0) return ''
      return html`
        <div class="form-section" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap">
          <label style="flex:1;min-width:200px;margin:0">${t('config.templateSelect')}
            <select id="tpl-select" name="template" style="margin:0">
              <option value="">${t('config.templateNone')}</option>
              ${roles.map(r => html`<option value="${r.slug}">${r.slug} — ${r.description}</option>`)}
            </select>
          </label>
          <button type="button" id="tpl-preview-btn" class="outline" style="margin:0" onclick="
            var slug = document.getElementById('tpl-select').value;
            if (!slug) return;
            fetch('/api/role-preview/' + slug).then(r => r.json()).then(d => {
              var el = document.getElementById('tpl-preview-content');
              el.textContent = d.content;
              document.getElementById('tpl-preview').open = true;
            });
          ">${icon('eye', 13)} ${t('config.templatePreview')}</button>
          <button type="button" class="outline" style="margin:0"
            hx-post="/bot/${name}/config/apply-template" hx-include="#tpl-select"
            hx-target="#config-alerts" hx-swap="innerHTML"
            hx-confirm="${t('config.templateApplyConfirm')}"
          >${icon('file-input', 13)} ${t('config.templateApply')}</button>
        </div>
        <details id="tpl-preview" style="margin-bottom:0.75rem">
          <summary>${t('config.templatePreview')}</summary>
          <pre id="tpl-preview-content" style="max-height:400px;overflow:auto;font-size:0.82rem;white-space:pre-wrap;background:var(--mc-surface2);padding:0.75rem;border-radius:var(--radius-sm)"></pre>
        </details>
      `
    })()}
    <h3 class="section-title">${icon('files')} Workspace Files</h3>
    ${(() => {
      const dir = getBotDir(name)
      const hasWs = hasWorkspaceFiles(dir)
      if (!hasWs) {
        return html`
          <div class="form-section">
            <p style="color:var(--mc-muted)">Workspace files не ініціалізовані. Бот використовує legacy CLAUDE.md.</p>
            <button type="button" hx-post="/bot/${name}/config/migrate-workspace" hx-target="#config-alerts" hx-swap="innerHTML"
              hx-confirm="Створити workspace files з поточного CLAUDE.md? Це не видаляє існуючий файл."
              class="outline">${icon('folder-plus', 13)} Migrate to Workspace Files</button>
          </div>
        `
      }
      const files = listWorkspaceFiles(dir)
      return html`
        <div class="form-section">
          <p style="margin:0 0 0.75rem;color:var(--mc-muted);font-size:0.8rem;line-height:1.5">
            🌐 <b>Global</b> файли (SOUL.md, TOOLS.md) спільні для всіх ботів — редагуються лише через
            <code>roles/_soul.md</code> / <code>roles/_tools.md</code> у git.
            <br>
            💡 Щоб per-bot файл (<code>BOT_SOUL.md</code> або <code>BOT_TOOLS.md</code>)
            <b>повністю замінив</b> відповідний global, додай у його перший рядок маркер:
            <code>&lt;!-- REPLACES_GLOBAL --&gt;</code>. Без маркера per-bot файл просто
            <b>доповнює</b> global.
          </p>
          ${files.filter(f => f.exists).map(f => {
            const content = readWorkspaceFile(dir, f.name) ?? ''
            const rows = Math.min(Math.max(content.split('\n').length + 2, 6), 20)
            const sourceFile = f.name === 'SOUL.md' ? '_soul.md' : f.name === 'TOOLS.md' ? '_tools.md' : ''
            const fileHints: Record<string, string> = {
              'IDENTITY.md': 'Ім\'я, emoji і 1-2 речення хто це. Без правил та інструкцій.',
              'SOUL.md': 'Характер, цінності, етика, межі, meta-правила взаємодії. Спільне для всіх ботів.',
              'BOT_SOUL.md': 'Тільки відмінності цього бота від глобального характеру. Або повна заміна з маркером REPLACES_GLOBAL.',
              'ROLE.md': 'Спеціалізація бота та доменні робочі сценарії. Без tool routing і без generic character.',
              'TOOLS.md': 'Master tool routing table + канонічні drilldown секції з прикладами. Спільне для всіх ботів.',
              'BOT_TOOLS.md': 'Лише role-specific tool routing, якого нема в глобальному TOOLS (наприклад, Home Assistant для асистента).',
              'USER.md': 'Сталий профіль користувача: ім\'я, мова, timezone, контекст, top-level вподобання. Динамічні дані — у SaveFact / MEMORY.',
              'MEMORY.md': 'Курована мета-пам\'ять: правила-уроки, патерни, прийняті рішення з "тому що". Не сирі факти (це SaveFact).',
            }
            const hint = fileHints[f.name] ?? ''
            // Compute overlap with global counterpart for BOT_SOUL/BOT_TOOLS
            let overlapWarning: ReturnType<typeof html> | string = ''
            if (f.name === 'BOT_SOUL.md' || f.name === 'BOT_TOOLS.md') {
              const globalName = f.name === 'BOT_SOUL.md' ? 'SOUL.md' : 'TOOLS.md'
              const globalContent = readWorkspaceFile(dir, globalName as WorkspaceFileName) ?? ''
              const hasReplacesMarker = content.trimStart().startsWith('<!-- REPLACES_GLOBAL -->')
              if (!hasReplacesMarker && globalContent && content.trim()) {
                const ratio = overlapRatio(content, globalContent)
                const pct = Math.round(ratio * 100)
                if (ratio >= 0.95) {
                  overlapWarning = html`
                    <p style="margin:0.25rem 0;padding:0.5rem;background:#5a1a1a;color:#fee;border-radius:var(--radius-sm);font-size:0.82rem">
                      🛑 <b>${pct}% дублює global</b> (${globalName === 'SOUL.md' ? 'roles/_soul.md' : 'roles/_tools.md'}).
                      Майже повна копія — вилучи дублі або додай маркер
                      <code>&lt;!-- REPLACES_GLOBAL --&gt;</code> на перший рядок для повної заміни.
                    </p>
                  `
                } else if (ratio >= 0.80) {
                  overlapWarning = html`
                    <p style="margin:0.25rem 0;padding:0.5rem;background:#5a4a1a;color:#ffe;border-radius:var(--radius-sm);font-size:0.82rem">
                      ⚠️ <b>${pct}% дублює global</b>. Залиш у цьому файлі лише різницю — генерик контент іде з
                      <code>roles/${globalName === 'SOUL.md' ? '_soul.md' : '_tools.md'}</code>.
                    </p>
                  `
                }
              }
            }
            return html`
              <details ${f.writable ? 'open' : ''} style="margin-bottom:0.75rem">
                <summary style="display:flex;align-items:center;gap:0.5rem">
                  ${icon(f.global ? 'globe' : f.writable ? 'file-edit' : 'file-text', 14)}
                  <b>${f.name}</b>
                  ${f.global
                    ? html`<span class="badge" style="font-size:0.7rem;background:#3a5fcd;color:#fff">global</span>`
                    : f.writable
                      ? html`<span class="badge badge-running" style="font-size:0.7rem">bot-writable</span>`
                      : html`<span class="badge badge-stopped" style="font-size:0.7rem">bot-readonly</span>`}
                  <small style="color:var(--mc-muted)">${(f.size / 1024).toFixed(1)} KB · ${estimateTokens(content).toLocaleString('uk-UA')} токенів</small>
                </summary>
                ${hint
                  ? html`<p style="margin:0.5rem 0 0.25rem;color:var(--mc-muted);font-size:0.78rem;font-style:italic">${hint}</p>`
                  : ''}
                ${f.global
                  ? html`
                      <p style="margin:0.25rem 0;color:var(--mc-muted);font-size:0.85rem">
                        🌐 Спільний для всіх ботів. Редагується через
                        <code>roles/${sourceFile}</code> у git.
                      </p>
                      <textarea class="code" rows="${rows}" readonly>${content}</textarea>
                    `
                  : html`
                      ${overlapWarning}
                      <form hx-post="/bot/${name}/config/workspace-file" hx-target="#config-alerts" hx-swap="innerHTML" style="margin-top:0.5rem">
                        <input type="hidden" name="filename" value="${f.name}">
                        <textarea name="content" class="code" rows="${rows}">${content}</textarea>
                        <button type="submit" style="margin-top:0.25rem">${icon('save', 13)} Save ${f.name}</button>
                      </form>
                    `}
              </details>
            `
          })}
          ${(() => {
            const assembled = assembleFromWorkspaceFiles(dir)
            const rows = Math.min(Math.max(assembled.split('\n').length + 2, 8), 30)
            const tokens = estimateTokens(assembled)
            return html`
              <details style="margin-top:1rem">
                <summary style="display:flex;align-items:center;gap:0.5rem">
                  ${icon('eye', 14)}
                  <b>Assembled CLAUDE.md (preview)</b>
                  <span class="badge" style="font-size:0.7rem;background:#555;color:#fff">read-only</span>
                  <small style="color:var(--mc-muted)">${(assembled.length / 1024).toFixed(1)} KB · ${tokens.toLocaleString('uk-UA')} токенів</small>
                </summary>
                <p style="margin:0.5rem 0;color:var(--mc-muted);font-size:0.8rem">
                  Це фінальний CLAUDE.md, який бачить агент. Збирається на льоту з 8 шарів вище
                  перед кожним запитом. Прямо редагувати не можна — змінюй окремі шари.
                </p>
                <textarea class="code" rows="${rows}" readonly>${assembled}</textarea>
              </details>
            `
          })()}
        </div>
      `
    })()}

    <div style="display:flex;flex-direction:column;gap:0.5rem;margin-top:1.5rem">
      <details>
        <summary>${icon('pencil')} ${t('config.rename')}</summary>
        <form method="POST" action="/bot/${name}/rename">
          <div style="display:flex;gap:0.5rem;align-items:end">
            <label style="flex:1">${t('config.newName')}
              <input type="text" name="new_name" required pattern="[a-z][a-z0-9_-]*" placeholder="${name}"
                title="${t('config.nameHint')}">
            </label>
            <button type="submit">${icon('pencil', 13)} ${t('config.renameBtn')}</button>
          </div>
        </form>
      </details>

      <details class="danger">
        <summary>${icon('trash-2')} ${t('config.delete')}</summary>
        <p>${t('config.deleteArchiveNote')}</p>
        <form method="POST" action="/bot/${name}/delete" onsubmit="return confirm('${t('config.deleteConfirm', { name })}')">
          <button type="submit" class="danger">${icon('trash-2', 13)} ${t('config.deleteBtn', { name })}</button>
        </form>
      </details>
    </div>
  `

  return c.html(layout(`${name} ${t('botnav.config')}`, content, `/bot/${name}/config`, t, lang))
})

app.post('/bot/:name/config/agent', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const body = await c.req.parseBody()
  const model = String(body['model'] ?? 'sonnet')
  const backgroundModel = String(body['background_model'] ?? 'sonnet')
  const effort = String(body['effort'] ?? '')
  const chatId = readEnv(name)['ALLOWED_CHAT_ID'] ?? ''
  if (!chatId) {
    return c.html(alert('warning', t('config.noChatId')))
  }
  if (!MODEL_IDS.includes(model)) {
    return c.html(alert('error', t('config.invalidModel')))
  }
  if (!MODEL_IDS.includes(backgroundModel)) {
    return c.html(alert('error', t('config.invalidModel')))
  }
  if (!EFFORT_IDS.includes(effort)) {
    return c.html(alert('error', t('config.invalidEffort')))
  }
  // Server-side safeguard: effort=max only for Opus
  if (effort === 'max' && !model.startsWith('opus')) {
    return c.html(alert('error', t('config.effortMaxOpusOnly')))
  }
  try {
    upsertSetting(name, chatId, 'model', model)
    upsertSetting(name, chatId, 'background_model', backgroundModel)
    upsertSetting(name, chatId, 'effort', effort)
  } catch {
    return c.html(alert('warning', t('config.noDb')))
  }
  return c.html(alert('success', t('config.agentSaved', { model, backgroundModel, effort: effort || 'default' })))
})

app.post('/bot/:name/config/env', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const body = await c.req.parseBody()
  const envRaw = String(body['env'] ?? '')

  // Parse and validate
  const parsed: Record<string, string> = {}
  for (const line of envRaw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    let val = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    parsed[trimmed.slice(0, eqIdx).trim()] = val
  }

  const errors = validateEnv(parsed)
  if (errors.length > 0) {
    writeEnvRaw(name, envRaw) // Save anyway, but warn
    return c.html(html`
      ${alert('warning', t('config.envWarnings'))}
      <ul style="margin:0.5rem 0">
        ${errors.map(e => html`<li><b>${e.key}</b>: ${e.message}</li>`)}
      </ul>
      <small>${t('config.restartRequired')}</small>
    `)
  }

  writeEnvRaw(name, envRaw)
  return c.html(alert('success', t('config.envSaved')))
})

app.post('/bot/:name/config/verify-token', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const env = readEnv(name)
  const token = env['TELEGRAM_BOT_TOKEN']
  if (!token) {
    return c.html(alert('error', t('config.noTelegramToken')))
  }
  const result = await verifyTelegramToken(token)
  if (result.ok) {
    return c.html(alert('success', t('config.tokenValid', { name: result.botName ?? '' })))
  }
  return c.html(alert('error', t('config.tokenInvalid', { error: result.error ?? '' })))
})

app.post('/bot/:name/config/apply-template', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const body = await c.req.parseBody()
  const slug = String(body['template'] ?? '').trim()

  if (!slug) {
    return c.html(alert('warning', t('config.templateNone')))
  }

  try {
    const roleMd = buildRoleMd(slug, name, '🤖')
    writeRoleMd(name, roleMd)

    // Check if new marker-based template
    const rolesDir = getRolesDir()
    const roleContent = readFileSync(resolve(rolesDir, `${slug}.md`), 'utf-8')
    const dir = getBotDir(name)

    if (roleContent.includes('--- IDENTITY ---')) {
      // New format: build workspace files directly, preserve USER.md and MEMORY.md
      const wsFiles = buildWorkspaceFilesFromRole(slug, name, '🤖', rolesDir)

      // Preserve existing user-owned data and bot-soul overlay
      const existingUser = readWorkspaceFile(dir, 'USER.md')
      const existingMemory = readWorkspaceFile(dir, 'MEMORY.md')
      const existingBotSoul = readWorkspaceFile(dir, 'BOT_SOUL.md')
      if (existingUser) wsFiles['USER.md'] = existingUser
      if (existingMemory) wsFiles['MEMORY.md'] = existingMemory
      if (existingBotSoul && existingBotSoul.trim()) wsFiles['BOT_SOUL.md'] = existingBotSoul

      createWorkspaceFiles(dir, wsFiles as Record<WorkspaceFileName, string>)
    }

    // Refresh CLAUDE.md from new workspace files (assembled with global injection)
    refreshClaudeMd(dir)

    return c.html(html`
      ${alert('success', t('config.templateApplied', { slug }))}
      <script>setTimeout(function(){ location.reload(); }, 600);</script>
    `)
  } catch {
    return c.html(alert('error', t('config.templateNotFound')))
  }
})

// --- Workspace files endpoints ---

app.post('/bot/:name/config/workspace-file', validateBot, async (c) => {
  const name = botName(c)
  const body = await c.req.parseBody()
  const filename = String(body['filename'] ?? '') as WorkspaceFileName
  const content = String(body['content'] ?? '')
  const dir = getBotDir(name)

  if (isGlobalFile(filename)) {
    return c.html(alert('error', `${filename} — глобальний файл, редагується через roles/ у git, не через адмінку.`))
  }

  try {
    // Admin can write any per-bot workspace file (no writable check beyond global guard)
    const wsDir = resolve(dir, 'workspace-files')
    writeFileSync(resolve(wsDir, filename), content, 'utf-8')
    return c.html(alert('success', `${filename} saved`))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(alert('error', msg))
  }
})

app.post('/bot/:name/config/migrate-workspace', validateBot, async (c) => {
  const name = botName(c)
  const dir = getBotDir(name)

  if (hasWorkspaceFiles(dir)) {
    return c.html(alert('warning', 'Workspace files already exist'))
  }

  try {
    const claudeMdPath = resolve(dir, 'CLAUDE.md')
    if (!existsSync(claudeMdPath)) {
      return c.html(alert('error', 'CLAUDE.md not found'))
    }
    const claudeMd = readFileSync(claudeMdPath, 'utf-8')
    const wsFiles = splitRoleIntoWorkspaceFiles(claudeMd)
    createWorkspaceFiles(dir, wsFiles)
    return c.html(html`
      ${alert('success', 'Workspace files created successfully')}
      <script>setTimeout(function(){ location.reload(); }, 600);</script>
    `)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(alert('error', msg))
  }
})

app.post('/bot/:name/rename', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const body = await c.req.parseBody()
  const newName = String(body['new_name'] ?? '').toLowerCase().trim()

  if (!newName || !/^[a-z][a-z0-9_-]*$/.test(newName)) {
    return c.html(layout(t('config.rename'), html`${alert('error', t('config.invalidName'))} <a href="/bot/${name}/config">${t('common.back')}</a>`, `/bot/${name}`, t, lang))
  }
  if (newName === name) {
    return c.redirect(`/bot/${name}/config`)
  }

  const root = getProjectRoot()
  const oldDir = resolve(root, 'bots', name)
  const newDir = resolve(root, 'bots', newName)

  if (existsSync(newDir)) {
    return c.html(layout(t('config.rename'), html`${alert('error', t('config.botExists', { name: newName }))} <a href="/bot/${name}/config">${t('common.back')}</a>`, `/bot/${name}`, t, lang))
  }

  // Stop bot
  stopBot(name)
  await new Promise(r => setTimeout(r, 500))

  // Rename directory
  renameSync(oldDir, newDir)

  // Update team.json
  const teamPath = resolve(root, 'workspace', 'team.json')
  if (existsSync(teamPath)) {
    try {
      const team = JSON.parse(readFileSync(teamPath, 'utf-8'))
      if (team.bots?.[name]) {
        team.bots[newName] = team.bots[name]
        delete team.bots[name]
        if (team.manager === name) team.manager = newName
        writeFileSync(teamPath, JSON.stringify(team, null, 2) + '\n')
      }
    } catch { /* ignore */ }
  }

  return c.redirect(`/bot/${newName}/config`)
})

app.post('/bot/:name/delete', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)

  try {
    const result = await deleteBot(name)
    const content = html`
      ${alert('success', t('config.botDeleted', { name }))}
      <p>${t('config.backupPath', { filename: result.backupFilename })}</p>
      <p>${t('config.restoreHint2')}</p>
      <a href="/" role="button">${t('nav.dashboard')}</a>
    `
    return c.html(layout(t('config.delete'), content, '/', t, lang))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(layout(t('config.delete'), html`${alert('error', msg)} <a href="/bot/${name}/config">${t('common.back')}</a>`, `/bot/${name}`, t, lang))
  }
})

export default app
