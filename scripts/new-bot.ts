#!/usr/bin/env tsx

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve, basename } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { globSync } from 'fs'

const ROOT = resolve(import.meta.dirname, '..')
const ROLES_DIR = resolve(ROOT, 'workspace/roles')
const BOTS_DIR = resolve(ROOT, 'bots')
const TEAM_JSON = resolve(ROOT, 'workspace/team.json')
const ENV_EXAMPLE = resolve(ROOT, '.env.example')

// SQL schema for new bot database (same as create-bot route)
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

function getAvailableRoles(): string[] {
  if (!existsSync(ROLES_DIR)) return []
  const { readdirSync } = await_import_fs()
  return readdirSync(ROLES_DIR)
    .filter((f: string) => f.endsWith('.md') && f !== '_base.md')
    .map((f: string) => f.replace('.md', ''))
}

// Workaround: use sync imports
import { readdirSync } from 'fs'
function await_import_fs() { return { readdirSync } }

function buildClaudeMd(role: string, botName: string, emoji: string): string {
  const basePath = resolve(ROLES_DIR, '_base.md')
  const rolePath = resolve(ROLES_DIR, `${role}.md`)

  if (!existsSync(basePath)) {
    throw new Error(`Base template not found: ${basePath}`)
  }
  if (!existsSync(rolePath)) {
    throw new Error(`Role template not found: ${rolePath}`)
  }

  const base = readFileSync(basePath, 'utf-8')
  let content = readFileSync(rolePath, 'utf-8')

  // Replace placeholders
  content = content.replaceAll('{{BOT_NAME}}', botName)
  content = content.replaceAll('{{BOT_EMOJI}}', emoji)

  // Replace base include marker with actual base content
  content = content.replace('{{включено _base.md}}', base.trim())

  return content
}

function addToTeamJson(slug: string, description: string): void {
  let team: { manager: string; bots: Record<string, { description: string }> }

  if (existsSync(TEAM_JSON)) {
    team = JSON.parse(readFileSync(TEAM_JSON, 'utf-8'))
  } else {
    team = { manager: 'orchestrator', bots: {} }
  }

  team.bots[slug] = { description }
  writeFileSync(TEAM_JSON, JSON.stringify(team, null, 2) + '\n')
}

function getRoleDescription(role: string): string {
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
  return descriptions[role] || role
}

// --- Main ---

function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    const roles = getAvailableRoles()
    console.log(`
Usage: npm run new-bot -- <bot-slug> <role> [--emoji 🤖] [--name "Display Name"]

Available roles:
${roles.map(r => `  ${r.padEnd(22)} ${getRoleDescription(r)}`).join('\n')}

Example:
  npm run new-bot -- my-helper personal-assistant --emoji 🧑‍💼 --name "Мій Помічник"
`)
    process.exit(0)
  }

  const slug = args[0]
  const role = args[1]

  if (!slug || !role) {
    console.error('Error: bot-slug and role are required')
    process.exit(1)
  }

  // Parse optional flags
  let emoji = '🤖'
  let displayName = slug
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--emoji' && args[i + 1]) {
      emoji = args[i + 1]
      i++
    } else if (args[i] === '--name' && args[i + 1]) {
      displayName = args[i + 1]
      i++
    }
  }

  // Validate slug
  if (!/^[a-z][a-z0-9_-]*$/.test(slug)) {
    console.error('Error: bot slug must be lowercase letters, digits, hyphens, underscores. Start with a letter.')
    process.exit(1)
  }

  // Validate role
  const roles = getAvailableRoles()
  if (!roles.includes(role)) {
    console.error(`Error: unknown role "${role}". Available: ${roles.join(', ')}`)
    process.exit(1)
  }

  // Check bot doesn't exist
  const botDir = resolve(BOTS_DIR, slug)
  if (existsSync(botDir)) {
    console.error(`Error: bot "${slug}" already exists at ${botDir}`)
    process.exit(1)
  }

  console.log(`Creating bot "${slug}" with role "${role}"...`)

  // 1. Create directories
  mkdirSync(resolve(botDir, 'store'), { recursive: true })
  mkdirSync(resolve(botDir, 'core'), { recursive: true })
  mkdirSync(resolve(botDir, 'context', 'memories'), { recursive: true })
  mkdirSync(resolve(botDir, 'knowledge', 'memory'), { recursive: true })
  console.log('  Created directories')

  // 2. Build and write CLAUDE.md
  const claudeMd = buildClaudeMd(role, displayName, emoji)
  writeFileSync(resolve(botDir, 'CLAUDE.md'), claudeMd)
  console.log('  Created CLAUDE.md')

  // 3. Copy .env.example
  if (existsSync(ENV_EXAMPLE)) {
    const envContent = readFileSync(ENV_EXAMPLE, 'utf-8')
    writeFileSync(resolve(botDir, '.env'), envContent)
  } else {
    writeFileSync(resolve(botDir, '.env'), 'TELEGRAM_BOT_TOKEN=\nALLOWED_CHAT_ID=\nLOG_LEVEL=info\n')
  }
  console.log('  Created .env')

  // 4. Initialize database
  const dbPath = resolve(botDir, 'store', 'botva.db')
  const db = new DatabaseSync(dbPath)
  db.exec(INIT_SQL)
  db.close()
  console.log('  Initialized database')

  // 5. Write KEY_EVENTS.md
  writeFileSync(resolve(botDir, 'context', 'KEY_EVENTS.md'), '# Key Events\n\n(auto-updated during daily consolidation)\n')

  // 6. Add to team.json
  const description = getRoleDescription(role)
  addToTeamJson(slug, description)
  console.log('  Added to workspace/team.json')

  console.log(`\nBot "${slug}" created successfully!`)
  console.log(`\nNext steps:`)
  console.log(`  1. Edit bots/${slug}/.env -- set TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID`)
  console.log(`  2. Customize bots/${slug}/CLAUDE.md if needed`)
  console.log(`  3. Run: deploy restart`)
}

main()
