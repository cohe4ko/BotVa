import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { layout } from '../views/layout.js'
import { alert } from '../views/components.js'
import { getBotNames } from '../db-multi.js'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import { getAvailableRoles, getRolesDir, createBot } from '../../bot-manager.js'

const app = new Hono<I18nEnv>()

// --- API: get role preview ---
app.get('/api/role-preview/:role', (c) => {
  const role = c.req.param('role')
  const rolesDir = getRolesDir()
  const rolePath = resolve(rolesDir, `${role}.md`)

  if (!existsSync(rolePath)) {
    return c.json({ error: 'Role not found' }, 404)
  }

  const content = readFileSync(rolePath, 'utf-8')
  // Strip placeholders for preview
  const preview = content
    .replace(/\{\{BOT_NAME\}\}/g, '(ім\'я бота)')
    .replace(/\{\{BOT_EMOJI\}\}/g, '🤖')
    .replace('{{включено _base.md}}', '(спільні правила команди)')
    .replace(/^---\s*(IDENTITY|ROLE|TOOLS)\s*---$/gm, '')

  return c.json({ content: preview })
})

app.get('/create-bot', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const existing = getBotNames()
  const roles = getAvailableRoles()
  const hasRoles = roles.length > 0

  const roleOptions = roles.map(r => html`<option value="${r.slug}" data-description="${r.description}">${r.slug} -- ${r.description}</option>`)

  const content = html`
    <h2 style="margin-bottom:0.25rem"><i data-lucide="plus-circle" style="width:18px;height:18px;display:inline-block;vertical-align:middle"></i> ${t('create.title')}</h2>
    <p style="margin-bottom:1.25rem">${t('create.desc')}</p>

    <div id="create-alerts"></div>

    <form method="POST" action="/create-bot">
      <div class="form-section">
        <div class="grid">
          <label>${t('create.botName')}
            <input type="text" name="name" required pattern="[a-z][a-z0-9_-]*" placeholder="${t('create.botNamePlaceholder')}"
              title="${t('config.nameHint')}">
          </label>
          <div style="display:flex;gap:0.5rem;align-items:end">
            <label style="flex:1">${t('create.displayName')}
              <input type="text" name="display_name" placeholder="${t('create.displayNamePlaceholder')}">
            </label>
            <label style="width:5rem">${t('create.emoji')}
              <input type="text" name="emoji" placeholder="🤖" maxlength="4">
            </label>
          </div>
        </div>
      </div>

      ${hasRoles ? html`
        <div class="form-section">
          <label style="margin-bottom:0"><i data-lucide="sparkles" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('create.roleTemplate')}
            <select name="role" id="role-select">
              <option value="">${t('create.noTemplate')}</option>
              ${roleOptions}
            </select>
          </label>
          <div id="role-preview" style="display:none; margin-top:0.5rem">
            <details class="inline">
              <summary>${t('create.previewRole')}</summary>
              <pre id="role-preview-content" style="max-height:400px;overflow:auto;font-size:0.82rem;white-space:pre-wrap;background:var(--mc-surface2);padding:0.75rem;border-radius:var(--radius-sm)"></pre>
            </details>
          </div>
        </div>
      ` : ''}

      <div class="form-section">
        <h4 style="margin:0 0 0.6rem;font-size:0.82rem"><i data-lucide="send" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('create.telegram')}</h4>
        <label>${t('create.botToken')}
          <input type="text" name="token" required placeholder="${t('create.botTokenPlaceholder')}">
        </label>
        <label style="margin-top:0.5rem">${t('create.allowedChatId')}
          <input type="text" name="chat_id" placeholder="${t('create.chatIdPlaceholder')}">
        </label>
      </div>

      <div class="form-section">
        <h4 style="margin:0 0 0.6rem;font-size:0.82rem"><i data-lucide="key" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('create.apiKeys')}</h4>
        <label>${t('create.groqKey')}
          <input type="text" name="groq_key" placeholder="gsk_...">
        </label>
        <label style="margin-top:0.5rem">${t('create.googleKey')}
          <input type="text" name="google_key" placeholder="AIza...">
        </label>
      </div>

      <div class="form-section" id="personality-section">
        <label style="margin-bottom:0"><i data-lucide="file-pen" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('create.personalityDesc')}
          <textarea name="personality" rows="3" placeholder="${t('create.personalityPlaceholder')}"></textarea>
        </label>
      </div>

      <button type="submit" style="margin-top:0.25rem"><i data-lucide="plus" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i> ${t('create.submit')}</button>
    </form>

    ${existing.length > 0 ? html`
      <h3 class="section-title" style="margin-top:2rem"><i data-lucide="bot" style="width:15px;height:15px;display:inline-block;vertical-align:middle"></i> ${t('create.existingBots')}</h3>
      <div style="display:flex;flex-wrap:wrap;gap:0.4rem">
        ${existing.map(name => html`<a href="/bot/${name}/config" class="badge badge-${name}" style="font-size:0.78rem;padding:0.25rem 0.6rem;text-decoration:none">${name}</a>`)}
      </div>
    ` : ''}

    ${hasRoles ? html`
      <script>
        document.getElementById('role-select')?.addEventListener('change', async function() {
          const preview = document.getElementById('role-preview');
          const previewContent = document.getElementById('role-preview-content');
          const personalitySection = document.getElementById('personality-section');
          const role = this.value;
          if (role) {
            try {
              const resp = await fetch('/api/role-preview/' + role);
              const data = await resp.json();
              previewContent.textContent = data.content;
              preview.style.display = 'block';
              personalitySection.style.display = 'none';
            } catch(e) {
              preview.style.display = 'none';
              personalitySection.style.display = 'block';
            }
          } else {
            preview.style.display = 'none';
            personalitySection.style.display = 'block';
          }
        });
      </script>
    ` : ''}
  `

  return c.html(layout(t('create.title'), content, '/create-bot', t, lang))
})

app.post('/create-bot', async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const body = await c.req.parseBody()
  const name = String(body['name'] ?? '').toLowerCase().trim()
  const displayName = String(body['display_name'] ?? '') || name
  const token = String(body['token'] ?? '').trim()
  const chatId = String(body['chat_id'] ?? '').trim()
  const groqKey = String(body['groq_key'] ?? '').trim()
  const googleKey = String(body['google_key'] ?? '').trim()
  const personality = String(body['personality'] ?? '').trim()
  const role = String(body['role'] ?? '').trim()
  const emoji = String(body['emoji'] ?? '').trim() || '🤖'

  try {
    createBot({ name, token, role: role || undefined, displayName, emoji, chatId, groqKey, googleKey, personality })

    const roleStr = role ? t('create.withRole', { role }) : ''
    const content = html`
      ${alert('success', t('create.success', { name, role: roleStr }))}
      <h3>${t('create.nextSteps')}</h3>
      <ol>
        <li>${t('create.reviewCustomize')} <a href="/bot/${name}/config">${name} ${t('botnav.config')}</a></li>
        <li>${t('create.startBot')}</li>
        <li>${t('create.getChatId')}</li>
      </ol>
      <h3>${t('create.createdFiles')}</h3>
      <pre>bots/${name}/
  .env              -- Telegram token, API keys
  CLAUDE.md         -- Bot personality and instructions${role ? ` (role: ${role})` : ''}
  core/             -- Bot personality and skills (transferable)
  context/          -- User knowledge (can be cleared to reset)
    KEY_EVENTS.md   -- Event index
    memories/       -- Daily diary files
  knowledge/        -- Domain knowledge
    memory/         -- Knowledge memory logs
  store/
    botva.db   -- SQLite database (initialized)</pre>
      <div class="btn-group">
        <a href="/bot/${name}/config" role="button">${t('create.configureBot', { name })}</a>
        <a href="/create-bot" role="button" class="secondary outline">${t('create.createAnother')}</a>
      </div>
    `

    return c.html(layout(`${name} Created`, content, '/create-bot', t, lang))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(layout(t('create.title'), html`${alert('error', msg)} <a href="/create-bot">${t('common.back')}</a>`, '/create-bot', t, lang))
  }
})

export default app
