import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { layout } from '../views/layout.js'
import { alert } from '../views/components.js'
import { getBotNames, getProjectRoot } from '../db-multi.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { DatabaseSync } from 'node:sqlite'

const app = new Hono()

function getRolesDir(): string {
  return resolve(getProjectRoot(), 'workspace/roles')
}

function getAvailableRoles(): { slug: string; description: string }[] {
  const rolesDir = getRolesDir()
  if (!existsSync(rolesDir)) return []

  const descriptions: Record<string, string> = {
    'personal-assistant': 'Персональний асистент. Повсякденні задачі, розклад, CRM, розумний дім.',
    'researcher': 'Дослідник/аналітик. Глибокий аналіз, верифікація фактів, звіти.',
    'health-advisor': 'Асистент зі здоров\'я. Моніторинг показників, аналізи, препарати.',
    'academic': 'Академічний помічник. PhD, наукові статті, методологія, викладання.',
    'creative': 'Креативний асистент. Дизайн, зображення, презентації, копірайтинг.',
    'sales': 'Продажі та CRM. Ліди, угоди, аналіз продажів, комерційні пропозиції.',
    'planner': 'Планувальник. Задачі, дедлайни, пріоритизація, зведення.',
    'knowledge-base': 'База знань. Документація, FAQ, пошук внутрішніх знань.',
    'manager': 'Менеджер команди. Координація ботів, делегування, синтез результатів.',
    'product-market': 'Продукт, клієнти, ринок. CRM-аналітика, позиціонування, конкуренти, контент.',
    'webmaster': 'Вебмайстер. Редагування сайту, контент, деплой через rsync/scp, SEO.',
  }

  return readdirSync(rolesDir)
    .filter(f => f.endsWith('.md') && f !== '_base.md')
    .map(f => f.replace('.md', ''))
    .map(slug => ({ slug, description: descriptions[slug] || slug }))
}

function buildClaudeMd(role: string, botName: string, emoji: string): string {
  const rolesDir = getRolesDir()
  const basePath = resolve(rolesDir, '_base.md')
  const rolePath = resolve(rolesDir, `${role}.md`)

  const base = readFileSync(basePath, 'utf-8')
  let content = readFileSync(rolePath, 'utf-8')

  content = content.replaceAll('{{BOT_NAME}}', botName)
  content = content.replaceAll('{{BOT_EMOJI}}', emoji)
  content = content.replace('{{включено _base.md}}', base.trim())

  return content
}

function addToTeamJson(root: string, slug: string, description: string): void {
  const teamPath = resolve(root, 'workspace/team.json')
  let team: { manager: string; bots: Record<string, { description: string }> }

  if (existsSync(teamPath)) {
    team = JSON.parse(readFileSync(teamPath, 'utf-8'))
  } else {
    team = { manager: 'orchestrator', bots: {} }
  }

  team.bots[slug] = { description }
  writeFileSync(teamPath, JSON.stringify(team, null, 2) + '\n')
}

const DEFAULT_CLAUDE_MD = (name: string) => `## ${name}

You are a personal AI assistant, accessible via Telegram.
You run as a persistent service.

## Personality

Your name is ${name}. You are helpful, direct, and concise.

Rules you never break:
- No em dashes. Ever.
- No AI cliches. Never say "Certainly!", "Great question!", "I'd be happy to", "As an AI".
- No sycophancy.
- No excessive apologies. If you got something wrong, fix it and move on.
- Don't narrate what you're about to do. Just do it.
- If you don't know something, say so plainly.

## Your Job

Execute. Don't explain what you're about to do -- just do it.
When the user asks for something, they want the output, not a plan.
If you need clarification, ask one short question.

## Your Environment

- All global Claude Code skills (~/.claude/skills/) are available
- Tools: Bash, file system, web search, browser automation, all MCP servers
- This project lives at the directory where CLAUDE.md is located

## Web Search

You have WebSearch and WebFetch tools. Use them proactively:
- When the user asks about current events, prices, weather, news
- When you need up-to-date info (your training data has a cutoff)
- When answering factual questions you're not 100% sure about

Don't ask "do you want me to search?" -- just search.

## Message Format

- Keep responses tight and readable
- Use plain text over heavy markdown
- For long outputs: summary first, offer to expand
- Voice messages arrive as \`[Voice transcribed]: ...\` -- treat as normal text
`

const ENV_TEMPLATE = (token: string, chatId: string, groqKey: string, googleKey: string) => {
  const lines = [`TELEGRAM_BOT_TOKEN=${token}`]
  if (chatId) lines.push(`ALLOWED_CHAT_ID=${chatId}`)
  if (groqKey) lines.push(`GROQ_API_KEY=${groqKey}`)
  if (googleKey) lines.push(`GOOGLE_API_KEY=${googleKey}`)
  lines.push('LOG_LEVEL=info')
  return lines.join('\n') + '\n'
}

// SQL schema for new bot database (mirrors src/db.ts initDatabase)
const INIT_SQL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  topic_key TEXT,
  content TEXT NOT NULL,
  sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
  salience REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  next_run INTEGER NOT NULL,
  last_run INTEGER,
  last_result TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (chat_id, key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type);
`

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

  return c.json({ content: preview })
})

app.get('/create-bot', (c) => {
  const existing = getBotNames()
  const roles = getAvailableRoles()
  const hasRoles = roles.length > 0

  const roleOptions = roles.map(r => html`<option value="${r.slug}" data-description="${r.description}">${r.slug} -- ${r.description}</option>`)

  const content = html`
    <h2>Create New Bot</h2>

    <p>Creates a new bot directory under <code>bots/</code> with all required files and database.</p>

    <div id="create-alerts"></div>

    <form method="POST" action="/create-bot">
      <div class="grid">
        <label>Bot name (lowercase, no spaces)
          <input type="text" name="name" required pattern="[a-z][a-z0-9_-]*" placeholder="e.g. tutor, writer, coder"
            title="Lowercase letters, digits, hyphens, underscores. Start with a letter.">
        </label>
        <div style="display:flex;gap:0.5rem;align-items:end">
          <label style="flex:1">Display name
            <input type="text" name="display_name" placeholder="e.g. Мій Помічник">
          </label>
          <label style="width:5rem">Emoji
            <input type="text" name="emoji" placeholder="🤖" maxlength="4">
          </label>
        </div>
      </div>

      ${hasRoles ? html`
        <fieldset>
          <legend>Role Template</legend>
          <label>Choose a role
            <select name="role" id="role-select">
              <option value="">-- No template (blank bot) --</option>
              ${roleOptions}
            </select>
          </label>
          <div id="role-preview" style="display:none; margin-top:0.5rem">
            <details>
              <summary>Preview role template</summary>
              <pre id="role-preview-content" style="max-height:400px;overflow:auto;font-size:0.85em;white-space:pre-wrap"></pre>
            </details>
          </div>
        </fieldset>
      ` : ''}

      <fieldset>
        <legend>Telegram</legend>
        <label>Bot Token (from @BotFather)
          <input type="text" name="token" required placeholder="123456:ABC-DEF...">
        </label>
        <label>Allowed Chat ID
          <input type="text" name="chat_id" placeholder="e.g. 82244336 (get via /chatid)">
        </label>
      </fieldset>

      <fieldset>
        <legend>API Keys (optional, can be added later)</legend>
        <label>Groq API Key (voice transcription)
          <input type="text" name="groq_key" placeholder="gsk_...">
        </label>
        <label>Google API Key (image generation, Stagehand browser)
          <input type="text" name="google_key" placeholder="AIza...">
        </label>
      </fieldset>

      <fieldset id="personality-section">
        <legend>Personality</legend>
        <label>Bot description / personality
          <textarea name="personality" rows="3" placeholder="Brief description of what this bot does and how it behaves..."></textarea>
        </label>
      </fieldset>

      <button type="submit">Create Bot</button>
    </form>

    <h3>Existing bots</h3>
    <ul>
      ${existing.map(name => html`<li><a href="/bot/${name}/config">${name}</a></li>`)}
    </ul>

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

  return c.html(layout('Create Bot', content, '/create-bot'))
})

app.post('/create-bot', async (c) => {
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

  // Validate
  if (!name || !/^[a-z][a-z0-9_-]*$/.test(name)) {
    return c.html(layout('Create Bot', html`${alert('error', 'Invalid bot name. Use lowercase letters, digits, hyphens.')} <a href="/create-bot">Back</a>`, '/create-bot'))
  }

  if (!token) {
    return c.html(layout('Create Bot', html`${alert('error', 'Telegram bot token is required.')} <a href="/create-bot">Back</a>`, '/create-bot'))
  }

  const root = getProjectRoot()
  const botDir = resolve(root, 'bots', name)

  if (existsSync(botDir)) {
    return c.html(layout('Create Bot', html`${alert('error', `Bot "${name}" already exists.`)} <a href="/create-bot">Back</a>`, '/create-bot'))
  }

  // Validate role if provided
  if (role) {
    const rolePath = resolve(getRolesDir(), `${role}.md`)
    if (!existsSync(rolePath)) {
      return c.html(layout('Create Bot', html`${alert('error', `Role "${role}" not found.`)} <a href="/create-bot">Back</a>`, '/create-bot'))
    }
  }

  try {
    // Create directory structure
    mkdirSync(resolve(botDir, 'store'), { recursive: true })
    mkdirSync(resolve(botDir, 'core'), { recursive: true })
    mkdirSync(resolve(botDir, 'context', 'memories'), { recursive: true })
    mkdirSync(resolve(botDir, 'knowledge', 'memory'), { recursive: true })

    // Write .env
    writeFileSync(resolve(botDir, '.env'), ENV_TEMPLATE(token, chatId, groqKey, googleKey))

    // Write CLAUDE.md
    let claudeMd: string
    if (role) {
      claudeMd = buildClaudeMd(role, displayName, emoji)
    } else {
      claudeMd = DEFAULT_CLAUDE_MD(displayName)
      if (personality) {
        claudeMd = claudeMd.replace(
          'You are helpful, direct, and concise.',
          personality
        )
      }
    }
    writeFileSync(resolve(botDir, 'CLAUDE.md'), claudeMd)

    // Initialize database
    const dbPath = resolve(botDir, 'store', 'botva.db')
    const db = new DatabaseSync(dbPath)
    db.exec(INIT_SQL)
    db.close()

    // Write initial KEY_EVENTS.md
    writeFileSync(resolve(botDir, 'context', 'KEY_EVENTS.md'), `# Key Events\n\n(auto-updated during daily consolidation)\n`)

    // Add to team.json
    const roles = getAvailableRoles()
    const roleInfo = roles.find(r => r.slug === role)
    const description = roleInfo?.description || personality || `${displayName} bot`
    addToTeamJson(root, name, description)

    const content = html`
      ${alert('success', `Bot "${name}" created successfully${role ? ` with role "${role}"` : ''}!`)}
      <h3>Next steps</h3>
      <ol>
        <li>Review and customize: <a href="/bot/${name}/config">${name} Config</a></li>
        <li>Start the bot: go to <a href="/">Dashboard</a> and click Start</li>
        <li>Send <code>/chatid</code> to your bot in Telegram to get the chat ID (if you didn't set it)</li>
      </ol>
      <h3>Created files</h3>
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
        <a href="/bot/${name}/config" role="button">Configure ${name}</a>
        <a href="/create-bot" role="button" class="secondary outline">Create another</a>
      </div>
    `

    return c.html(layout(`${name} Created`, content, '/create-bot'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(layout('Create Bot', html`${alert('error', `Failed to create bot: ${msg}`)} <a href="/create-bot">Back</a>`, '/create-bot'))
  }
})

export default app
