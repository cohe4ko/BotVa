import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { getBotNames, getHealthMetrics, getUsageSummary, getBotDir, getProjectRoot } from '../db-multi.js'
import { getBotStatus, getBotUptime } from '../bot-control.js'
import { readEnv } from '../env-parser.js'
import { getMcpServersConfig } from '../../mcp-config.js'
import { getBuiltinToolDefs } from '../../builtin-tools.js'
import { getTeamConfig } from '../../team.js'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants as fsConstants } from 'fs'
import { execSync } from 'child_process'
import { resolve, join } from 'path'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

// --- Snapshot collection ---

function getNodeVersion(): string { return process.versions.node }
function getClaudeVersion(): string {
  try { return execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim() }
  catch { return '(not found)' }
}
function getDiskUsage(dir: string): string {
  try { return execSync(`du -sh "${dir}" 2>/dev/null`, { encoding: 'utf-8' }).split('\t')[0].trim() }
  catch { return '?' }
}

function tailErrors(botName: string, lines = 50): string {
  const paths = [
    `/tmp/botva-${botName}.log`,
    join(getBotDir(botName), 'store', 'bot.log'),
    join(getBotDir(botName), 'bot.log'),
  ]
  for (const p of paths) {
    if (existsSync(p)) {
      const all = readFileSync(p, 'utf-8').split('\n')
      const errors = all.filter(l => /\b(ERROR|WARN|error|warn|ERR|fatal)\b/i.test(l)).slice(-lines)
      return errors.join('\n')
    }
  }
  return ''
}

function getEnvExampleKeys(): string[] {
  const exPath = resolve(getProjectRoot(), '.env.example')
  if (!existsSync(exPath)) return []
  return readFileSync(exPath, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => l.split('=')[0].trim())
}

function getSkillsList(): { name: string; enabled: boolean }[] {
  const skillsDir = resolve(getProjectRoot(), '.claude', 'skills')
  if (!existsSync(skillsDir)) return []
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({
        name: d.name,
        enabled: existsSync(join(skillsDir, d.name, 'SKILL.md')),
      }))
  } catch { return [] }
}

function fileInfo(path: string): string {
  try {
    if (!existsSync(path)) return 'MISSING'
    const st = statSync(path)
    const size = st.size
    const sizeStr = size > 1048576 ? `${(size / 1048576).toFixed(1)}MB` : size > 1024 ? `${(size / 1024).toFixed(0)}KB` : `${size}B`
    const mode = '0' + (st.mode & 0o777).toString(8)
    const mtime = new Date(st.mtimeMs).toISOString().slice(0, 16)
    return `${sizeStr}, mode=${mode}, modified=${mtime}`
  } catch { return 'ERROR' }
}

function dirListing(dir: string, depth = 0, maxDepth = 2): string[] {
  const result: string[] = []
  if (!existsSync(dir)) return ['(directory does not exist)']
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env' && e.name !== '.claude') continue
      if (['node_modules', 'dist', 'build', 'venv', '.git'].includes(e.name)) continue
      const full = join(dir, e.name)
      const indent = '  '.repeat(depth)
      if (e.isDirectory()) {
        result.push(`${indent}${e.name}/  ${getDiskUsage(full)}`)
        if (depth < maxDepth) result.push(...dirListing(full, depth + 1, maxDepth))
      } else {
        result.push(`${indent}${e.name}  ${fileInfo(full)}`)
      }
    }
  } catch { result.push('(read error)') }
  return result
}

function getDbStats(botName: string): string {
  try {
    const db = require('better-sqlite3')(join(getBotDir(botName), 'store', 'botva.db'), { readonly: true })
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
    const counts: string[] = []
    for (const t of tables) {
      try {
        const { cnt } = db.prepare(`SELECT COUNT(*) as cnt FROM "${t}"`).get() as any
        counts.push(`${t}=${cnt}`)
      } catch { counts.push(`${t}=?`) }
    }
    db.close()
    return counts.join(', ')
  } catch { return '(no db or read error)' }
}

function getDiskFree(): string {
  try { return execSync("df -h . 2>/dev/null | tail -1 | awk '{print \"total=\"$2\", used=\"$3\", avail=\"$4\", use%=\"$5}'", { encoding: 'utf-8', cwd: getProjectRoot() }).trim() }
  catch { return '?' }
}

function getProcessMemory(): string {
  const mem = process.memoryUsage()
  return `rss=${(mem.rss / 1048576).toFixed(0)}MB, heap=${(mem.heapUsed / 1048576).toFixed(0)}/${(mem.heapTotal / 1048576).toFixed(0)}MB`
}

function execSafe(cmd: string, timeoutMs = 10000): string {
  try { return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs, cwd: getProjectRoot() }).trim() }
  catch { return '' }
}

function isWritable(dir: string): boolean {
  try { accessSync(dir, fsConstants.W_OK); return true } catch { return false }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function getScheduledTasksForBot(botName: string): string {
  try {
    const db = require('better-sqlite3')(join(getBotDir(botName), 'store', 'botva.db'), { readonly: true })
    const tasks = db.prepare('SELECT id, schedule, status, last_run, next_run, last_result FROM scheduled_tasks ORDER BY id').all() as any[]
    db.close()
    if (tasks.length === 0) return '(none)'
    return tasks.map((t: any) => {
      const lastRun = t.last_run ? new Date(t.last_run * 1000).toISOString().slice(0, 16) : 'never'
      const nextRun = t.next_run ? new Date(t.next_run * 1000).toISOString().slice(0, 16) : '?'
      const lastResult = t.last_result ? t.last_result.slice(0, 80) : ''
      return `  #${t.id}: "${t.schedule}" status=${t.status}, last=${lastRun}, next=${nextRun}${t.status === 'error' ? `, result="${lastResult}"` : ''}`
    }).join('\n')
  } catch { return '(no db)' }
}

function getLastConsolidation(botName: string): string {
  // Check diary directory for most recent file
  const diaryDir = join(getBotDir(botName), 'knowledge', 'diary')
  if (!existsSync(diaryDir)) return 'never (no diary directory)'
  try {
    const files = readdirSync(diaryDir).filter(f => f.endsWith('.md')).sort().reverse()
    if (files.length === 0) return 'never (diary empty)'
    const latest = files[0]
    const st = statSync(join(diaryDir, latest))
    return `${latest}, ${files.length} total, latest modified ${new Date(st.mtimeMs).toISOString().slice(0, 16)}`
  } catch { return '(read error)' }
}

async function collectSystemSnapshot(lang: Lang): Promise<string> {
  const root = getProjectRoot()
  const botNames = getBotNames()
  const envExampleKeys = getEnvExampleKeys()

  const lines: string[] = []
  const add = (s: string) => lines.push(s)

  // System info
  add('=== SYSTEM INFO ===')
  add(`Node.js: ${getNodeVersion()}`)
  add(`Claude CLI: ${getClaudeVersion()}`)
  add(`Platform: ${process.platform} ${process.arch}`)
  add(`Admin process memory: ${getProcessMemory()}`)
  add(`Disk: ${getDiskFree()}`)
  add(`Project: ${root}`)
  add(`Project size: ${getDiskUsage(root)}`)
  add(`Date: ${new Date().toISOString()}`)
  add(`Uptime: ${Math.floor(process.uptime() / 60)} min`)
  add(`Bots: ${botNames.join(', ') || '(none)'}`)
  add('')

  // Project file structure (top level)
  add('=== PROJECT STRUCTURE ===')
  add(dirListing(root, 0, 1).join('\n'))
  add('')

  // Per-bot detailed
  for (const name of botNames) {
    add(`=== BOT: ${name} ===`)
    const botDir = getBotDir(name)
    const status = getBotStatus(name)
    const uptime = getBotUptime(name)
    add(`Status: ${status.running ? 'RUNNING' : 'STOPPED'}${status.pid ? ` (PID ${status.pid})` : ''}${uptime ? `, uptime: ${uptime}` : ''}`)
    add(`Disk: ${getDiskUsage(botDir)}`)

    // File structure
    add('Files:')
    const botFiles = ['.env', 'CLAUDE.md', 'store/botva.db', 'store/botva.pid', 'store/colleague.sock']
    for (const f of botFiles) {
      add(`  ${f}: ${fileInfo(join(botDir, f))}`)
    }

    // Knowledge directory
    const knowDir = join(botDir, 'knowledge')
    if (existsSync(knowDir)) {
      add('  knowledge/:')
      try {
        const kFiles = readdirSync(knowDir, { withFileTypes: true })
        for (const kf of kFiles) {
          add(`    ${kf.name}${kf.isDirectory() ? '/' : ''} ${fileInfo(join(knowDir, kf.name))}`)
        }
        if (kFiles.length === 0) add('    (empty)')
      } catch { add('    (read error)') }
    } else {
      add('  knowledge/: MISSING')
    }

    // CLAUDE.md size and first line
    const claudeMdPath = join(botDir, 'CLAUDE.md')
    if (existsSync(claudeMdPath)) {
      try {
        const content = readFileSync(claudeMdPath, 'utf-8')
        const lineCount = content.split('\n').length
        add(`  CLAUDE.md: ${lineCount} lines, ~${Math.ceil(content.length / 4)} tokens`)
        const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#'))
        if (firstLine) add(`  CLAUDE.md preview: "${firstLine.trim().slice(0, 100)}"`)
      } catch {}
    }

    // Env keys
    const env = readEnv(name)
    const requiredKeys = ['TELEGRAM_BOT_TOKEN', 'ALLOWED_CHAT_ID']
    const importantKeys = ['GOOGLE_API_KEY', 'GROQ_API_KEY', 'ADMIN_TOKEN', 'LOG_LEVEL']
    const integrationKeys = ['BITRIX24_WEBHOOK_URL', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'HA_URL', 'HA_TOKEN', 'META_ACCESS_TOKEN', 'PUBLISH_SSH_HOST']
    const tuningKeys = ['AGENT_WATCHDOG_WARN_SECONDS', 'AGENT_WATCHDOG_TIMEOUT_MS', 'NIGHT_OWL_HOUR', 'TELEGRAPH_ENABLED']

    add('Env (required):')
    for (const k of requiredKeys) add(`  ${k}: ${env[k] ? 'SET' : 'MISSING'}`)
    add('Env (important):')
    for (const k of importantKeys) add(`  ${k}: ${env[k] ? 'SET' : 'not set'}`)
    add('Env (integrations):')
    for (const k of integrationKeys) add(`  ${k}: ${env[k] ? 'SET' : 'not set'}`)
    add('Env (tuning):')
    for (const k of tuningKeys) add(`  ${k}: ${env[k] ? `SET (${env[k]})` : 'default'}`)

    // Extra env keys not in template
    const allKnownKeys = [...requiredKeys, ...importantKeys, ...integrationKeys, ...tuningKeys, ...envExampleKeys]
    const extraKeys = Object.keys(env).filter(k => !allKnownKeys.includes(k))
    if (extraKeys.length > 0) add(`Env (extra/custom): ${extraKeys.join(', ')}`)

    // DB stats
    add(`DB tables: ${getDbStats(name)}`)

    // Health metrics
    try {
      const h = getHealthMetrics(name)
      const todayTs = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)
      const weekTs = todayTs - 7 * 86400
      const monthTs = todayTs - 30 * 86400
      const usageToday = getUsageSummary(name, todayTs)
      const usageWeek = getUsageSummary(name, weekTs)
      const usageMonth = getUsageSummary(name, monthTs)
      add(`Requests: today=${usageToday.requests}, 7d=${usageWeek.requests}, 30d=${usageMonth.requests}`)
      add(`Cost: today=$${usageToday.costUSD.toFixed(4)}, 7d=$${usageWeek.costUSD.toFixed(2)}, 30d=$${usageMonth.costUSD.toFixed(2)}`)
      add(`Tokens 30d: input=${usageMonth.inputTokens}, output=${usageMonth.outputTokens}`)
      add(`Errors 24h: ${h.errorCount24h}, avg response: ${h.avgResponseTimeMs ?? '?'}ms`)
      if (h.lastActivity) {
        const lastAgo = Math.round((Date.now() / 1000 - h.lastActivity) / 60)
        add(`Last activity: ${lastAgo} min ago`)
      } else {
        add('Last activity: never')
      }
    } catch { add('Health: (no database)') }

    // Log tail (last 30 error/warn lines)
    const errors = tailErrors(name, 30)
    if (errors) {
      add('Recent errors/warnings (last 30):')
      add(errors.slice(0, 3000))
    } else {
      add('Logs: no errors/warnings found')
    }
    add('')
  }

  // MCP servers
  add('=== MCP SERVERS ===')
  const mergedEnv: Record<string, string> = {}
  for (const name of botNames) {
    const bEnv = readEnv(name)
    for (const [k, v] of Object.entries(bEnv)) { if (v && !mergedEnv[k]) mergedEnv[k] = v }
  }
  const mcpServers = getMcpServersConfig(mergedEnv)
  for (const s of mcpServers) {
    add(`${s.name}:`)
    add(`  status: ${s.enabled ? 'ENABLED' : s.userEnabled ? 'MISSING DEPS' : 'DISABLED'}`)
    add(`  command: ${s.command} ${s.args.join(' ').slice(0, 100)}`)
    add(`  requires: ${s.condition}`)
  }
  add('')

  // MCP server binaries check
  add('=== MCP SERVER FILES ===')
  const mcpDir = join(root, 'mcp-servers')
  if (existsSync(mcpDir)) {
    try {
      const dirs = readdirSync(mcpDir, { withFileTypes: true }).filter(d => d.isDirectory())
      for (const d of dirs) {
        const serverDir = join(mcpDir, d.name)
        const hasBuild = existsSync(join(serverDir, 'build'))
        const hasVenv = existsSync(join(serverDir, 'venv'))
        const hasPkg = existsSync(join(serverDir, 'package.json'))
        const hasNodeMod = existsSync(join(serverDir, 'node_modules'))
        const parts = [`${d.name}/:`]
        if (hasPkg) parts.push(`pkg=yes, build=${hasBuild ? 'yes' : 'MISSING'}, node_modules=${hasNodeMod ? 'yes' : 'MISSING'}`)
        if (hasVenv) parts.push('venv=yes (python)')
        if (!hasPkg && !hasVenv) parts.push('(no package.json or venv)')
        add(`  ${parts.join(' ')}`)
      }
    } catch {}
  }
  add('')

  // Builtin tools
  add('=== BUILTIN TOOLS ===')
  const tools = getBuiltinToolDefs()
  for (const t of tools) {
    add(`${t.name}: enabled=${t.enabled}, available=${t.available}${t.condition ? `, needs=${t.condition}` : ''} [${t.category}]`)
  }
  add('')

  // Team
  add('=== TEAM ===')
  const team = getTeamConfig(root)
  add(`Manager: ${team.manager || '(not set)'}`)
  if (team.bots && Object.keys(team.bots).length > 0) {
    for (const [b, info] of Object.entries(team.bots)) {
      const inBots = botNames.includes(b)
      add(`${b}: ${(info as any).description || '(no description)'}${!inBots ? ' [WARNING: bot directory not found]' : ''}`)
    }
  } else {
    add('(no team configured)')
  }
  // Check: bots exist but not in team
  const teamBotNames = Object.keys(team.bots ?? {})
  const orphanBots = botNames.filter(b => !teamBotNames.includes(b) && b !== team.manager)
  if (orphanBots.length > 0) add(`Bots not in team: ${orphanBots.join(', ')}`)
  add('')

  // Skills
  add('=== SKILLS ===')
  const skills = getSkillsList()
  if (skills.length === 0) { add('(none)') } else {
    for (const s of skills) add(`/${s.name}: ${s.enabled ? 'on' : 'OFF'}`)
  }
  add('')

  // Backups
  add('=== BACKUPS ===')
  try {
    const { listBackups, formatSize } = await import('../../backup/index.js')
    const backups = listBackups()
    add(`Total: ${backups.length}`)
    if (backups.length > 0) {
      for (const b of backups.slice(0, 5)) {
        add(`  ${b.filename}: ${b.manifest?.type ?? '?'}, bots=[${b.manifest?.bots?.join(',') ?? '?'}], ${formatSize(b.sizeBytes)}, ${b.createdAt?.toISOString?.() ?? '?'}`)
      }
      if (backups.length > 5) add(`  ... and ${backups.length - 5} more`)
    } else {
      add('(no backups — consider setting up automatic backups)')
    }
  } catch { add('(backup module not available)') }
  add('')

  // Workspace files
  add('=== WORKSPACE ===')
  const wsDir = join(root, 'workspace')
  if (existsSync(wsDir)) {
    add(dirListing(wsDir, 0, 1).join('\n'))
  } else {
    add('workspace/: MISSING (should be created on first bot start)')
  }
  add('')

  // Root config files
  add('=== CONFIG FILES ===')
  const configFiles = ['mcp-servers.json', '.env.example', 'package.json', 'tsconfig.json', 'CLAUDE.md', 'DEPLOY.md']
  for (const f of configFiles) {
    add(`${f}: ${fileInfo(join(root, f))}`)
  }
  // Root .env is optional — mark it clearly
  const rootEnvStatus = fileInfo(join(root, '.env'))
  add(`.env (optional, fallback): ${rootEnvStatus}`)
  add('')

  // Disk usage breakdown
  add('=== DISK USAGE ===')
  add(`bots/: ${getDiskUsage(join(root, 'bots'))}`)
  add(`workspace/: ${getDiskUsage(wsDir)}`)
  add(`mcp-servers/: ${getDiskUsage(join(root, 'mcp-servers'))}`)
  add(`node_modules/: ${getDiskUsage(join(root, 'node_modules'))}`)
  add(`backups/: ${getDiskUsage(join(root, 'backups'))}`)
  add(`.claude/: ${getDiskUsage(join(root, '.claude'))}`)
  add(`Disk free: ${getDiskFree()}`)
  add('')

  // Git status
  add('=== GIT ===')
  const gitBranch = execSafe('git branch --show-current')
  add(`Branch: ${gitBranch || '(not a git repo)'}`)
  if (gitBranch) {
    const lastCommit = execSafe('git log --oneline -1')
    add(`Last commit: ${lastCommit}`)
    const aheadBehind = execSafe('git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null')
    if (aheadBehind) {
      const [ahead, behind] = aheadBehind.split('\t')
      add(`Ahead: ${ahead}, Behind: ${behind}`)
    }
    const changes = execSafe('git status --porcelain')
    if (changes) {
      const changeLines = changes.split('\n').filter(Boolean)
      add(`Uncommitted changes: ${changeLines.length} files`)
      for (const l of changeLines.slice(0, 15)) add(`  ${l}`)
      if (changeLines.length > 15) add(`  ... and ${changeLines.length - 15} more`)
    } else {
      add('Working tree: clean')
    }
  }
  add('')

  // Running processes
  add('=== PROCESSES ===')
  const procs = execSafe("ps aux | grep -E 'tsx.*index|tsx.*server|tsx.*diagnostic|node.*botva' | grep -v grep")
  if (procs) {
    const procLines = procs.split('\n').filter(Boolean)
    add(`BotVa processes: ${procLines.length}`)
    for (const p of procLines) {
      // Extract PID and command
      const parts = p.trim().split(/\s+/)
      const pid = parts[1]
      const cmd = parts.slice(10).join(' ').slice(0, 120)
      add(`  PID ${pid}: ${cmd}`)
    }
  } else {
    add('BotVa processes: 0')
  }
  add('')

  // Stale files (per bot)
  add('=== STALE FILES ===')
  let staleCount = 0
  for (const name of botNames) {
    const botDir = getBotDir(name)
    const pidFile = join(botDir, 'store', 'botva.pid')
    const sockFile = join(botDir, 'store', 'colleague.sock')
    const botStatus = getBotStatus(name)

    if (existsSync(pidFile) && !botStatus.running) {
      try {
        const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
        if (!isNaN(pid) && !isProcessAlive(pid)) {
          add(`${name}: STALE PID file (PID ${pid} not alive) → ${pidFile}`)
          staleCount++
        }
      } catch {}
    }
    if (existsSync(sockFile) && !botStatus.running) {
      add(`${name}: STALE SOCKET file (bot not running) → ${sockFile}`)
      staleCount++
    }
  }
  if (staleCount === 0) add('(none)')
  add('')

  // Scheduled tasks
  add('=== SCHEDULED TASKS ===')
  for (const name of botNames) {
    const tasks = getScheduledTasksForBot(name)
    add(`${name}:`)
    add(tasks)
  }
  add('')

  // Memory consolidation
  add('=== CONSOLIDATION ===')
  for (const name of botNames) {
    add(`${name}: ${getLastConsolidation(name)}`)
  }
  add('')

  // Claude CLI
  add('=== CLAUDE CLI ===')
  const claudeVer = execSafe('claude --version 2>/dev/null', 5000)
  add(`Version: ${claudeVer || '(not installed)'}`)
  // Check if authenticated by attempting a simple status check
  if (claudeVer) {
    const authCheck = execSafe('claude auth status 2>&1', 5000)
    add(`Auth: ${authCheck || '(could not check)'}`)
  }
  add('')

  // npm health
  add('=== NPM ===')
  add(`node_modules: ${existsSync(join(root, 'node_modules')) ? `exists, ${getDiskUsage(join(root, 'node_modules'))}` : 'MISSING'}`)
  add(`package-lock.json: ${fileInfo(join(root, 'package-lock.json'))}`)
  // npm outdated (with timeout, only top-level)
  const outdated = execSafe('npm outdated --depth=0 2>/dev/null | head -10', 10000)
  if (outdated) {
    add('Outdated packages:')
    add(outdated)
  } else {
    add('Outdated: (all up to date or check timed out)')
  }
  add('')

  // Permissions
  add('=== PERMISSIONS ===')
  const checkDirs = ['bots', 'workspace', 'backups', '.claude']
  for (const d of checkDirs) {
    const full = join(root, d)
    if (existsSync(full)) {
      add(`${d}/: writable=${isWritable(full) ? 'yes' : 'NO'}, ${fileInfo(full)}`)
    } else {
      add(`${d}/: does not exist`)
    }
  }
  // Per-bot store writable
  for (const name of botNames) {
    const storeDir = join(getBotDir(name), 'store')
    if (existsSync(storeDir)) {
      add(`bots/${name}/store/: writable=${isWritable(storeDir) ? 'yes' : 'NO'}`)
    }
  }
  add('')

  // Large files
  add('=== LARGE FILES (>50MB) ===')
  const largeFiles = execSafe("find . -size +50M -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/venv/*' -exec ls -lh {} \\; 2>/dev/null | head -20")
  if (largeFiles) {
    add(largeFiles)
  } else {
    add('(none found)')
  }

  return lines.join('\n')
}

// --- Analysis prompt ---

function buildDiagPrompt(lang: Lang): string {
  const langInst = lang === 'uk'
    ? 'IMPORTANT: All text values in JSON (summary, title, detail, fix, text) MUST be in Ukrainian.'
    : 'IMPORTANT: All text values in JSON (summary, title, detail, fix, text) MUST be in English.'

  return `You are a senior BotVa platform engineer performing installation diagnostics. You have deep expertise in every component of BotVa. Use this knowledge base to analyze the system snapshot.

${langInst}

# BotVa Platform Architecture

BotVa is a multi-bot Telegram platform where each bot is a Claude AI agent with tools, memory, and MCP integrations.

## Directory Structure
- \`bots/<name>/\` — per-bot directory, each has its own .env, CLAUDE.md, store/
- \`bots/<name>/.env\` — bot config (tokens, API keys). REQUIRED for bot to work.
- \`bots/<name>/CLAUDE.md\` — bot personality/role instructions. Without it the bot has no personality.
- \`bots/<name>/store/botva.db\` — SQLite DB (sessions, memories, usage, tasks, audit). Created on first start.
- \`bots/<name>/store/botva.pid\` — PID lock file. If bot isn't running but PID file exists = stale lock.
- \`bots/<name>/knowledge/\` — optional knowledge base files the bot can read.
- \`workspace/\` — shared data: team.json, builtin-tools.json, gallery.db, admin.lock
- \`mcp-servers.json\` — MCP server registry (auto-created with defaults on first run)
- \`.claude/skills/\` — Claude Code skills (SKILL.md = enabled, SKILL.md.off = disabled)
- \`backups/\` — backup archives

## Environment Variables
Each bot has its OWN .env file at \`bots/<name>/.env\`. There is NO requirement for a root .env file — root .env is OPTIONAL and only used as fallback if a bot's .env is missing. Do NOT recommend creating root .env if bots have their own .env files configured correctly. ADMIN_TOKEN can be in any bot's .env since the admin panel reads from the running bot's env.

REQUIRED per bot (bot won't work without these):
- TELEGRAM_BOT_TOKEN — from @BotFather. Each bot MUST have unique token.
- ALLOWED_CHAT_ID — comma-separated Telegram chat IDs authorized to use the bot. Without this = security risk.

IMPORTANT OPTIONAL:
- GOOGLE_API_KEY — enables: image generation (Imagen), image editing, Stagehand browser AI. Many features depend on this.
- GROQ_API_KEY — enables: voice transcription (STT). Without it, voice messages are ignored.
- LOG_LEVEL — debug/info/warn/error. Default: info. Set to debug for troubleshooting.
- ADMIN_TOKEN — protects admin panel. WITHOUT THIS THE ADMIN PANEL IS UNPROTECTED.

INTEGRATIONS (enable specific MCP servers):
- BITRIX24_WEBHOOK_URL — Bitrix24 CRM integration
- GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET — Google Workspace (Docs, Sheets)
- HA_URL + HA_TOKEN — Home Assistant smart home
- META_ACCESS_TOKEN — Meta/Facebook ads
- PUBLISH_SSH_HOST + PUBLISH_REMOTE_DIR — file publishing via SSH

TUNING:
- AGENT_WATCHDOG_WARN_SECONDS (default 60) — warn if agent takes too long
- AGENT_WATCHDOG_TIMEOUT_MS (default 600000 = 10 min) — kill agent if stuck
- NIGHT_OWL_HOUR (default 4) — hour for daily memory consolidation
- TTS_VOICE_UK, TTS_VOICE_EN, TTS_VOICE_RU — edge-tts voice names

## Bot Lifecycle
- Started via \`scripts/deploy.sh start <bot>\` or admin panel
- Logs to /tmp/botva-<bot>.log
- PID stored in bots/<bot>/store/botva.pid
- On start: acquires lock, inits DB, creates Telegram bot, starts scheduler, opens colleague socket
- Healthy bot: running, has recent activity (<1h), low error count, reasonable response times (<30s avg)
- Degraded bot: running but errors, slow responses (>60s), or no activity for hours
- Critical: not running but should be, or constant errors

## MCP Servers
Each MCP server is a subprocess that provides tools to the agent via Model Context Protocol.
- \`playwright-remote\` — browser automation, needs Playwright running on port 9222. If not running = connection errors.
- \`stagehand\` — AI browser automation, REQUIRES GOOGLE_API_KEY. Without it = won't start.
- \`bitrix24\` — CRM, REQUIRES BITRIX24_WEBHOOK_URL
- \`google-workspace\` — Google Docs/Sheets, REQUIRES GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET
- \`home-assistant\` — smart home, REQUIRES HA_URL + HA_TOKEN
- \`meta-ads\` — Facebook ads, REQUIRES META_ACCESS_TOKEN
- \`pubmed\` — medical research, Python-based, needs venv at mcp-servers/pubmed/venv/
- \`macos-control\` — macOS system control (AppleScript), only works on macOS

If a server is ENABLED but its required env vars are missing = it will fail on every agent call = wasteful and creates errors.

## Builtin Tools
Registered in-process (no subprocess). Require conditions:
- GenerateImage, EditImage — need GOOGLE_API_KEY
- TextToSpeech — always available (edge-tts, free)
- PublishTelegraph — needs TELEGRAPH_ENABLED=true (default)
- ShareFile — needs PUBLISH_SSH_HOST
- Gallery tools (List/Send/Delete) — always available
- Backup tools (Create/List/Verify/Restore/Delete) — always available
- SendMedia — always available (sends photo/document/voice/video)

If a tool is enabled but its condition not met = tool won't register = agent can't use it. Not an error, but misleading if user expects the tool.

## Team System
Multi-bot collaboration via colleague/manager MCP servers.
- workspace/team.json defines manager bot and bot descriptions
- Manager bot gets "colleague" MCP server (can send tasks to other bots)
- Worker bots get "manager" MCP server (can ask manager for help)
- Communication via Unix sockets at bots/<bot>/store/colleague.sock
- If team.json exists but manager bot isn't running = workers can't reach manager

## Memory System
- SQLite FTS5 for semantic search
- Daily consolidation at NIGHT_OWL_HOUR (default 04:00)
- Salience decay: memories fade over time unless reinforced
- If consolidation hasn't run (bot always stopped at 4am) = diary bloat

## Performance Benchmarks (what's normal)
- Avg response time: 5-30 seconds is normal, 30-60 is slow, >60 is problematic
- Error rate: <5% of requests is normal, >10% needs investigation
- Cost: $0.01-0.10 per request is typical, >$0.50 per request is expensive
- Disk per bot: 10-500 MB normal, >1 GB investigate (gallery images, large knowledge base)
- Total project: 1-5 GB normal, >10 GB consider cleanup

## Security Checklist
- ADMIN_TOKEN must be set — otherwise anyone with the URL can access admin panel
- ALLOWED_CHAT_ID must be set per bot — otherwise anyone can message the bot
- .env files must NOT be committed to git
- Token values must never appear in logs or error messages
- Bot tokens starting with digits + colon are Telegram bot tokens — never expose them
- API keys (GOOGLE_API_KEY, GROQ_API_KEY, etc.) — never expose

## Common Issues & Fixes
1. Bot not starting → check TELEGRAM_BOT_TOKEN is valid, check PID lock file not stale
2. Voice not working → GROQ_API_KEY missing or invalid
3. Images not generating → GOOGLE_API_KEY missing
4. MCP server errors in logs → check required env vars, check if dependency installed
5. High costs → check if unnecessary MCP servers enabled, check model (opus > sonnet > haiku cost)
6. Slow responses → too many MCP servers (each adds startup time), large CLAUDE.md, big memory context
7. Bot crash loop → check logs for repeated errors, check disk space
8. Admin panel exposed → set ADMIN_TOKEN in root .env
9. Team communication failing → check manager bot is running, check workspace/team.json

## Node.js Compatibility
- Supported: Node.js 20-24
- Known issue: Node.js 25+ has OOM problems with Claude Agent SDK
- If Node version is 25+ = critical warning

## Git Hygiene
- Uncommitted changes on production = deploy risk (changes can be lost on next pull/deploy)
- Behind remote = missing updates, potentially missing security fixes
- Untracked files in src/ = likely forgotten to commit
- Large number of changes = something wrong with deploy workflow

## Stale Files
- Stale PID file (process not alive) = bot crashed without cleanup. Fix: delete the PID file, investigate crash in logs
- Stale socket file = same, leftover from crash. Fix: delete the socket file
- These prevent clean bot restart

## npm Health
- Missing node_modules = npm install not run after deploy
- Outdated packages = potential security issues, especially for direct dependencies
- Missing package-lock.json = inconsistent installs across deploys

## Scheduled Tasks
- Tasks with status "error" = something failed, check last_result for details
- Tasks that haven't run for a long time = scheduler might be broken or bot was stopped
- Paused tasks = user intentionally paused, not necessarily an issue

## Memory Consolidation
- Daily consolidation compresses diary entries and updates KEY_EVENTS.md at NIGHT_OWL_HOUR (default 04:00)
- If bot is always stopped at 4am = consolidation never runs = diary grows indefinitely = more tokens used per request
- No diary directory = bot has never had consolidation run
- Fix: ensure bot runs past 4am, or trigger consolidation manually

## Claude CLI
- Must be authenticated for Claude Agent SDK to work
- If "not authenticated" = agents can't start = critical issue
- Run: claude auth login

## File Permissions
- store/ directories must be writable (SQLite needs write access)
- workspace/ must be writable (shared data: gallery, team, tools config)
- backups/ must be writable (backup creation)
- If any not writable = operations will fail silently or with cryptic errors

## Large Files
- Database files (botva.db) > 100MB = consider cleanup (old usage_log entries, memories with low salience)
- Gallery images > 50MB each = unusual, might be uncompressed
- Log files > 100MB = log rotation not working
- Any binary files in src/ = likely committed by mistake

Analyze the system snapshot below. Return ONLY valid JSON (no markdown fences).

Scoring guide:
- 90-100: all bots running, all required env set, no errors, good security
- 70-89: minor issues (optional keys missing, non-critical warnings, disabled MCP)
- 50-69: significant issues (bots stopped, missing deps, errors in logs, security gaps)
- 0-49: critical problems (no TELEGRAM_BOT_TOKEN, no bots, major errors, exposed admin)

For each issue: provide concrete fix with exact file path and command.

JSON structure:
{
  "health": "healthy|degraded|critical",
  "score": 85,
  "summary": "1-2 sentence overall assessment",
  "issues": [
    {
      "severity": "critical|warning|info",
      "category": "env|mcp|bot|disk|logs|security|performance|config",
      "title": "short title",
      "detail": "what's wrong and where",
      "fix": "how to fix it step by step"
    }
  ],
  "botReports": [
    {
      "name": "bot-name",
      "status": "healthy|degraded|critical|stopped",
      "summary": "1 sentence about this bot",
      "issues": [0, 1]
    }
  ],
  "mcpReport": [
    {
      "name": "server-name",
      "status": "ok|missing-deps|disabled|error",
      "detail": "explanation"
    }
  ],
  "recommendations": [
    {
      "priority": "high|medium|low",
      "title": "short title",
      "text": "detailed recommendation"
    }
  ],
  "security": [
    {
      "severity": "critical|warning",
      "title": "issue",
      "detail": "what's exposed or misconfigured"
    }
  ]
}

System snapshot:
`
}

// --- Helpers ---

async function collectQueryResult(conversation: AsyncIterable<SDKMessage>): Promise<string> {
  let result = ''
  for await (const event of conversation) {
    if (event.type === 'result') {
      result = event.subtype === 'success' ? event.result : (event.errors?.join('\n') ?? 'Error')
    }
  }
  return result
}

// --- Render ---

const SEVERITY_STYLE: Record<string, { icon: string; bg: string; color: string; border: string }> = {
  critical: { icon: 'alert-octagon', bg: 'var(--mc-red-light)', color: 'var(--mc-red)', border: 'rgba(239,68,68,0.2)' },
  warning:  { icon: 'alert-triangle', bg: 'var(--mc-yellow-light)', color: 'var(--mc-yellow)', border: 'rgba(245,158,11,0.2)' },
  info:     { icon: 'info', bg: 'var(--mc-blue-light)', color: 'var(--mc-blue)', border: 'rgba(59,130,246,0.2)' },
}

const PRIORITY_STYLE: Record<string, { icon: string; bg: string; color: string; border: string }> = {
  high:   { icon: 'arrow-up', bg: 'var(--mc-red-light)', color: 'var(--mc-red)', border: 'rgba(239,68,68,0.15)' },
  medium: { icon: 'minus', bg: 'var(--mc-yellow-light)', color: 'var(--mc-yellow)', border: 'rgba(245,158,11,0.15)' },
  low:    { icon: 'arrow-down', bg: 'var(--mc-blue-light)', color: 'var(--mc-blue)', border: 'rgba(59,130,246,0.15)' },
}

const BOT_STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  healthy:  { bg: 'var(--mc-green-light)', color: 'var(--mc-green)' },
  degraded: { bg: 'var(--mc-yellow-light)', color: 'var(--mc-yellow)' },
  critical: { bg: 'var(--mc-red-light)', color: 'var(--mc-red)' },
  stopped:  { bg: 'var(--mc-surface2)', color: 'var(--mc-text-dim)' },
}

const MCP_STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  ok:           { bg: 'var(--mc-green-light)', color: 'var(--mc-green)' },
  'missing-deps': { bg: 'var(--mc-yellow-light)', color: 'var(--mc-yellow)' },
  disabled:     { bg: 'var(--mc-surface2)', color: 'var(--mc-text-dim)' },
  error:        { bg: 'var(--mc-red-light)', color: 'var(--mc-red)' },
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--mc-green)'
  if (score >= 50) return 'var(--mc-yellow)'
  return 'var(--mc-red)'
}

// --- Routes ---

app.get('/diagnostics', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')

  const content = html`
    <h2>${icon('stethoscope')} ${t('sdiag.title')}</h2>
    <p style="color:var(--mc-text-secondary);font-size:0.85rem;margin-bottom:1rem">${t('sdiag.desc')}</p>

    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1.5rem">
      <button
        hx-post="/diagnostics/run"
        hx-target="#sdiag-results"
        hx-swap="innerHTML"
        hx-indicator="#sdiag-spinner"
        class="btn-sm"
        style="background:var(--mc-accent);color:#fff;border-color:var(--mc-accent)"
      >${icon('stethoscope', 13)} ${t('sdiag.run')}</button>
      <span id="sdiag-spinner" class="htmx-indicator" style="font-size:0.85rem;color:var(--mc-text-dim)">
        ${icon('loader', 13)} ${t('sdiag.running')}
      </span>
    </div>

    <div id="sdiag-results"></div>
  `

  return c.html(layout(t('sdiag.title'), content, '/diagnostics', t, lang))
})

app.post('/diagnostics/run', async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')

  // Collect snapshot
  const snapshot = await collectSystemSnapshot(lang)

  // Call model
  let analysisRaw: string
  try {
    const conversation = query({
      prompt: buildDiagPrompt(lang) + snapshot,
      options: {
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'sonnet',
      },
    })
    analysisRaw = await collectQueryResult(conversation)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(html`<div class="alert alert-error">${icon('alert-circle', 14)} ${msg}</div>`)
  }

  // Parse JSON
  let a: any = null
  try {
    let jsonStr = analysisRaw.trim()
    if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    a = JSON.parse(jsonStr)
  } catch {
    return c.html(html`
      <div class="alert alert-warning">${icon('alert-triangle', 14)} ${lang === 'uk' ? 'Не вдалось розпарсити JSON' : 'Failed to parse JSON'}</div>
      <pre style="white-space:pre-wrap;font-size:0.78rem;padding:1rem;background:var(--mc-surface2);border-radius:6px;max-height:500px;overflow:auto">${analysisRaw}</pre>
    `)
  }

  const issues: any[] = a.issues ?? []
  const botReports: any[] = a.botReports ?? []
  const mcpReport: any[] = a.mcpReport ?? []
  const recommendations: any[] = a.recommendations ?? []
  const security: any[] = a.security ?? []
  const score: number = a.score ?? 0

  return c.html(html`
    <!-- Health score -->
    <div style="display:flex;align-items:center;gap:1.5rem;margin-top:1rem;margin-bottom:1.5rem">
      <div style="width:90px;height:90px;border-radius:50%;border:4px solid ${scoreColor(score)};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <span style="font-size:2rem;font-weight:800;color:${scoreColor(score)};font-variant-numeric:tabular-nums">${score}</span>
      </div>
      <div>
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem">
          <span style="padding:0.15rem 0.55rem;border-radius:5px;font-size:0.75rem;font-weight:600;background:${a.health === 'healthy' ? 'var(--mc-green-light)' : a.health === 'degraded' ? 'var(--mc-yellow-light)' : 'var(--mc-red-light)'};color:${a.health === 'healthy' ? 'var(--mc-green)' : a.health === 'degraded' ? 'var(--mc-yellow)' : 'var(--mc-red)'}">${a.health?.toUpperCase()}</span>
        </div>
        <p style="font-size:0.9rem;color:var(--mc-text-secondary);margin:0;line-height:1.5">${a.summary}</p>
      </div>
    </div>

    <!-- Security alerts (if any) -->
    ${security.length > 0 ? html`
      <h3>${icon('shield-alert')} ${t('sdiag.security')} (${security.length})</h3>
      <div style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1.5rem">
        ${security.map((s: any) => html`
          <div style="padding:0.65rem 0.85rem;background:var(--mc-red-light);border:1px solid rgba(239,68,68,0.2);border-radius:var(--radius-sm);display:flex;gap:0.6rem;align-items:flex-start">
            <span style="color:var(--mc-red);flex-shrink:0;margin-top:1px">${icon('shield-alert', 15)}</span>
            <div>
              <div style="font-size:0.82rem;font-weight:600;color:var(--mc-text)">${s.title}</div>
              <div style="font-size:0.78rem;color:var(--mc-text-secondary);line-height:1.45">${s.detail}</div>
            </div>
          </div>
        `)}
      </div>
    ` : ''}

    <!-- Issues -->
    ${issues.length > 0 ? html`
      <h3>${icon('alert-circle')} ${t('sdiag.issues')} (${issues.length})</h3>
      <div class="table-wrap" style="margin-bottom:1.5rem">
        <table>
          <thead><tr>
            <th style="width:80px"></th>
            <th>${lang === 'uk' ? 'Проблема' : 'Issue'}</th>
            <th style="width:90px">${lang === 'uk' ? 'Категорія' : 'Category'}</th>
            <th>${lang === 'uk' ? 'Як виправити' : 'Fix'}</th>
          </tr></thead>
          <tbody>
            ${issues.map((iss: any, i: number) => {
              const sev = SEVERITY_STYLE[iss.severity] ?? SEVERITY_STYLE.info
              return html`
                <tr>
                  <td>
                    <span style="display:inline-flex;align-items:center;gap:0.2rem;padding:0.1rem 0.4rem;border-radius:3px;background:${sev.bg};color:${sev.color};font-size:0.68rem;font-weight:600">
                      ${icon(sev.icon, 11)} ${iss.severity}
                    </span>
                  </td>
                  <td>
                    <div style="font-size:0.82rem;font-weight:600;color:var(--mc-text)">${iss.title}</div>
                    <div style="font-size:0.75rem;color:var(--mc-text-secondary)">${iss.detail}</div>
                  </td>
                  <td><span style="font-size:0.68rem;color:var(--mc-text-dim)">${iss.category}</span></td>
                  <td style="font-size:0.75rem;color:var(--mc-text-secondary)">${iss.fix}</td>
                </tr>
              `
            })}
          </tbody>
        </table>
      </div>
    ` : ''}

    <!-- Bot reports -->
    ${botReports.length > 0 ? html`
      <h3>${icon('bot')} ${t('sdiag.bots')} (${botReports.length})</h3>
      <div class="stats-grid" style="margin-bottom:1.5rem">
        ${botReports.map((br: any) => {
          const st = BOT_STATUS_STYLE[br.status] ?? BOT_STATUS_STYLE.stopped
          return html`
            <div class="stat-card">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.35rem">
                <span class="badge badge-${br.name}" style="font-size:0.78rem">${br.name}</span>
                <span style="padding:0.1rem 0.4rem;border-radius:4px;font-size:0.65rem;font-weight:600;background:${st.bg};color:${st.color}">${br.status}</span>
              </div>
              <p style="font-size:0.78rem;color:var(--mc-text-secondary);margin:0;line-height:1.4">${br.summary}</p>
            </div>
          `
        })}
      </div>
    ` : ''}

    <!-- MCP report -->
    ${mcpReport.length > 0 ? html`
      <h3>${icon('plug')} ${t('sdiag.mcp')} (${mcpReport.length})</h3>
      <div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:1.5rem">
        ${mcpReport.map((m: any) => {
          const st = MCP_STATUS_STYLE[m.status] ?? MCP_STATUS_STYLE.disabled
          return html`
            <span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.25rem 0.6rem;border-radius:5px;background:${st.bg};color:${st.color};font-size:0.75rem;font-weight:600" title="${m.detail}">
              ${icon('plug', 12)} ${m.name}
            </span>
          `
        })}
      </div>
    ` : ''}

    <!-- Recommendations -->
    ${recommendations.length > 0 ? html`
      <h3>${icon('lightbulb')} ${t('sdiag.recommendations')} (${recommendations.length})</h3>
      <div style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1.5rem">
        ${recommendations.map((r: any) => {
          const pr = PRIORITY_STYLE[r.priority] ?? PRIORITY_STYLE.low
          return html`
            <div style="padding:0.65rem 0.85rem;background:${pr.bg};border:1px solid ${pr.border};border-radius:var(--radius-sm);display:flex;gap:0.6rem;align-items:flex-start">
              <span style="color:${pr.color};flex-shrink:0;margin-top:1px">${icon(pr.icon, 15)}</span>
              <div>
                <div style="font-size:0.82rem;font-weight:600;color:var(--mc-text);margin-bottom:0.1rem">${r.title}</div>
                <div style="font-size:0.78rem;color:var(--mc-text-secondary);line-height:1.45">${r.text}</div>
              </div>
            </div>
          `
        })}
      </div>
    ` : ''}

    <!-- Raw snapshot -->
    <details class="inline" style="margin-top:1rem">
      <summary>${icon('code', 13)} ${lang === 'uk' ? 'Сирий snapshot' : 'Raw snapshot'}</summary>
      <pre style="white-space:pre-wrap;font-size:0.72rem;margin-top:0.5rem;padding:1rem;background:var(--mc-surface2);border-radius:6px;max-height:500px;overflow:auto;line-height:1.5">${snapshot}</pre>
    </details>
  `)
})

export default app
