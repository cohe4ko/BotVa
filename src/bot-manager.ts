import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'fs'
import { resolve } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getBotNames, getBotDir, getProjectRoot, type BotName } from './admin/db-multi.js'
import { getBotStatus, getBotUptime, stopBot } from './admin/bot-control.js'
import { createBackup } from './backup/engine.js'
import { hasWorkspaceFiles, assembleFromWorkspaceFiles, buildWorkspaceFilesFromRole, splitRoleIntoWorkspaceFiles, splitDefaultIntoWorkspaceFiles, createWorkspaceFiles } from './workspace-files.js'

// --- Roles ---

export function getRolesDir(): string {
  return resolve(getProjectRoot(), 'roles')
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
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

export function getAvailableRoles(): { slug: string; description: string }[] {
  const rolesDir = getRolesDir()
  if (!existsSync(rolesDir)) return []

  return readdirSync(rolesDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .map(f => f.replace('.md', ''))
    .map(slug => ({ slug, description: ROLE_DESCRIPTIONS[slug] || slug }))
}

export function buildClaudeMd(role: string, botName: string, emoji: string): string {
  const rolesDir = getRolesDir()

  // New marker-based templates: build directly from workspace files
  const rolePath = resolve(rolesDir, `${role}.md`)
  const roleContent = readFileSync(rolePath, 'utf-8')

  if (roleContent.includes('--- IDENTITY ---')) {
    // New format: assemble via workspace files
    const wsFiles = buildWorkspaceFilesFromRole(role, botName, emoji, rolesDir)
    const parts = [
      wsFiles['IDENTITY.md'],
      wsFiles['SOUL.md'],
      wsFiles['ROLE.md'],
      wsFiles['TOOLS.md'],
    ].filter(Boolean)
    return parts.join('\n\n')
  }

  // Legacy format: inline _base.md
  const soul = readFileSync(resolve(rolesDir, '_soul.md'), 'utf-8')
  const tools = readFileSync(resolve(rolesDir, '_tools.md'), 'utf-8')
  const base = [soul.trim(), tools.trim()].join('\n\n')

  let content = roleContent
  content = content.replaceAll('{{BOT_NAME}}', botName)
  content = content.replaceAll('{{BOT_EMOJI}}', emoji)
  content = content.replace('{{включено _base.md}}', base)

  return content
}

/** Build role-specific part WITHOUT inlining _base.md (keeps placeholder) */
export function buildRoleMd(role: string, botName: string, emoji: string): string {
  const rolePath = resolve(getRolesDir(), `${role}.md`)
  let content = readFileSync(rolePath, 'utf-8')
  content = content.replaceAll('{{BOT_NAME}}', botName)
  content = content.replaceAll('{{BOT_EMOJI}}', emoji)
  return content
}

/** Assemble CLAUDE.md from workspace-files/ (preferred) or role.md + _base.md (legacy fallback). */
export function assembleClaudeMd(botName: string): string | null {
  const botDir = resolve(getProjectRoot(), 'bots', botName)

  // Prefer workspace files if they exist
  if (hasWorkspaceFiles(botDir)) {
    return assembleFromWorkspaceFiles(botDir)
  }

  // Legacy fallback: role.md + _base.md
  const roleMdPath = resolve(botDir, 'role.md')
  if (!existsSync(roleMdPath)) return null

  const basePath = resolve(getRolesDir(), '_base.md')
  const base = existsSync(basePath) ? readFileSync(basePath, 'utf-8').trim() : ''
  const role = readFileSync(roleMdPath, 'utf-8')

  return role.replace('{{включено _base.md}}', base)
}

// --- Team JSON ---

export function addToTeamJson(root: string, slug: string, description: string): void {
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

export function removeFromTeamJson(root: string, slug: string): void {
  const teamPath = resolve(root, 'workspace', 'team.json')
  if (!existsSync(teamPath)) return
  try {
    const team = JSON.parse(readFileSync(teamPath, 'utf-8'))
    delete team.bots[slug]
    writeFileSync(teamPath, JSON.stringify(team, null, 2) + '\n')
  } catch { /* ignore */ }
}

// --- Templates ---

export const DEFAULT_CLAUDE_MD = (name: string) => `## ${name}

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

export const ENV_TEMPLATE = (token: string, chatId: string, groqKey: string, googleKey: string) => {
  const lines = [`TELEGRAM_BOT_TOKEN=${token}`]
  if (chatId) lines.push(`ALLOWED_CHAT_ID=${chatId}`)
  if (groqKey) lines.push(`GROQ_API_KEY=${groqKey}`)
  if (googleKey) lines.push(`GOOGLE_API_KEY=${googleKey}`)
  lines.push('LOG_LEVEL=info')
  return lines.join('\n') + '\n'
}

// SQL schema for new bot database (mirrors src/db.ts initDatabase)
export const INIT_SQL = `
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

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'conversation',
  sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_chat_topic ON facts(chat_id, topic);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  content,
  tags,
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent'))
);

CREATE INDEX IF NOT EXISTS idx_reminders_status_time ON reminders(status, remind_at);

-- No delete/update triggers: Node.js SQLite doesn't support FTS5 delete commands in triggers
`

// --- Create Bot ---

export interface CreateBotParams {
  name: string
  token: string
  role?: string
  displayName?: string
  emoji?: string
  chatId?: string
  groqKey?: string
  googleKey?: string
  personality?: string
}

export interface CreateBotResult {
  name: string
  role?: string
  directory: string
}

export function createBot(params: CreateBotParams): CreateBotResult {
  const { name, token, role, emoji = '🤖', chatId = '', groqKey = '', googleKey = '', personality = '' } = params
  const displayName = params.displayName || name

  // Validate name
  if (!name || !/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new Error(`Invalid bot name "${name}". Must match: ^[a-z][a-z0-9_-]*$`)
  }

  if (!token) {
    throw new Error('Telegram bot token is required')
  }

  const root = getProjectRoot()
  const botDir = resolve(root, 'bots', name)

  if (existsSync(botDir)) {
    throw new Error(`Bot "${name}" already exists`)
  }

  // Validate role if provided
  if (role) {
    const rolePath = resolve(getRolesDir(), `${role}.md`)
    if (!existsSync(rolePath)) {
      throw new Error(`Role "${role}" not found. Available: ${getAvailableRoles().map(r => r.slug).join(', ')}`)
    }
  }

  // Create directory structure
  mkdirSync(resolve(botDir, 'store'), { recursive: true })
  mkdirSync(resolve(botDir, 'core'), { recursive: true })
  mkdirSync(resolve(botDir, 'context', 'memories'), { recursive: true })
  mkdirSync(resolve(botDir, 'knowledge', 'memory'), { recursive: true })

  // Write .env
  writeFileSync(resolve(botDir, '.env'), ENV_TEMPLATE(token, chatId, groqKey, googleKey))

  // Build workspace files and CLAUDE.md
  let wsFiles: Record<string, string>
  if (role) {
    const roleMd = buildRoleMd(role, displayName, emoji)
    writeFileSync(resolve(botDir, 'role.md'), roleMd)

    // New marker-based templates build workspace files directly
    const rolePath = resolve(getRolesDir(), `${role}.md`)
    const roleContent = readFileSync(rolePath, 'utf-8')
    if (roleContent.includes('--- IDENTITY ---')) {
      wsFiles = buildWorkspaceFilesFromRole(role, displayName, emoji, getRolesDir())
    } else {
      // Legacy: inline _base.md then split
      const claudeMd = buildClaudeMd(role, displayName, emoji)
      wsFiles = splitRoleIntoWorkspaceFiles(claudeMd)
    }
  } else {
    const claudeMd = DEFAULT_CLAUDE_MD(displayName)
    const finalClaudeMd = personality
      ? claudeMd.replace('You are helpful, direct, and concise.', personality)
      : claudeMd
    wsFiles = splitDefaultIntoWorkspaceFiles(finalClaudeMd, displayName, emoji)
  }
  createWorkspaceFiles(botDir, wsFiles)

  // Derive CLAUDE.md from workspace files
  const claudeMd = assembleFromWorkspaceFiles(botDir)
  writeFileSync(resolve(botDir, 'CLAUDE.md'), claudeMd)

  // Initialize database
  const dbPath = resolve(botDir, 'store', 'botva.db')
  const db = new DatabaseSync(dbPath)
  db.exec(INIT_SQL)
  db.close()

  // Add to team.json
  const roles = getAvailableRoles()
  const roleInfo = roles.find(r => r.slug === role)
  const description = roleInfo?.description || personality || `${displayName} bot`
  addToTeamJson(root, name, description)

  return { name, role, directory: botDir }
}

// --- Delete Bot ---

export interface DeleteBotResult {
  name: string
  backupFilename: string
}

export async function deleteBot(name: string): Promise<DeleteBotResult> {
  const root = getProjectRoot()
  const botDir = getBotDir(name)

  if (!existsSync(botDir)) {
    throw new Error(`Bot "${name}" not found`)
  }

  // Stop bot if running
  stopBot(name as BotName)
  await new Promise(r => setTimeout(r, 500))

  // Close cached DB connection (prevents WAL checkpoint hang)
  try {
    const { closeBotDb } = await import('./admin/db-multi.js')
    closeBotDb(name)
  } catch { /* admin module may not be loaded */ }

  // Backup before delete
  const info = createBackup({ type: 'bot', botName: name })

  // Remove bot directory
  rmSync(botDir, { recursive: true, force: true })

  // Remove from team.json
  removeFromTeamJson(root, name)

  return { name, backupFilename: info.filename }
}

// --- List Bots ---

export interface BotInfo {
  name: string
  running: boolean
  pid: number | null
  uptime: string | null
}

export function listBots(): BotInfo[] {
  const names = getBotNames()
  return names.map(name => {
    const status = getBotStatus(name)
    const uptime = getBotUptime(name)
    return { name, running: status.running, pid: status.pid, uptime }
  })
}
