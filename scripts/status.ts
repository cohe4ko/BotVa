import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

function check(label: string, ok: boolean, detail?: string): void {
  const icon = ok ? green('✓') : red('✗')
  const extra = detail ? ` (${detail})` : ''
  console.log(`  ${icon} ${label}${extra}`)
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  console.log(bold('\n  BotVa Status\n'))

  // Node version
  const nodeVersion = process.versions.node
  const nodeMajor = parseInt(nodeVersion.split('.')[0], 10)
  check('Node.js', nodeMajor >= 20, nodeVersion)

  // Claude CLI
  const claudeVersion = tryExec('claude --version 2>/dev/null')
  check('Claude CLI', !!claudeVersion, claudeVersion ?? 'not found')

  // .env exists
  const envPath = join(PROJECT_ROOT, '.env')
  const envExists = existsSync(envPath)
  check('.env file', envExists)

  if (envExists) {
    const envContent = readFileSync(envPath, 'utf-8')
    const envVars: Record<string, string> = {}
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0) envVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }

    // Bot token
    const hasToken = !!envVars['TELEGRAM_BOT_TOKEN']
    check('Telegram bot token', hasToken)

    if (hasToken) {
      // Validate token
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${envVars['TELEGRAM_BOT_TOKEN']}/getMe`
        )
        const data = await res.json() as { ok: boolean; result?: { username: string } }
        check('Bot token valid', data.ok, data.result?.username ? `@${data.result.username}` : undefined)
      } catch {
        check('Bot token validation', false, 'network error')
      }
    }

    // Chat ID
    check('Chat ID configured', !!envVars['ALLOWED_CHAT_ID'], envVars['ALLOWED_CHAT_ID'] || 'not set')

    // Groq
    check('Voice STT (Groq)', !!envVars['GROQ_API_KEY'], envVars['GROQ_API_KEY'] ? 'configured' : 'not set')
  }

  // Database
  const dbPath = join(PROJECT_ROOT, 'store', 'botva.db')
  check('Database', existsSync(dbPath))

  if (existsSync(dbPath)) {
    const memCount = tryExec(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM memories" 2>/dev/null`)
    if (memCount !== null) check('Memory entries', true, memCount)

    const taskCount = tryExec(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM scheduled_tasks" 2>/dev/null`)
    if (taskCount !== null) check('Scheduled tasks', true, taskCount)
  }

  // Service status (macOS)
  if (process.platform === 'darwin') {
    const launchctl = tryExec('launchctl list com.botva.app 2>/dev/null')
    check('launchd service', launchctl !== null, launchctl ? 'running' : 'not loaded')
  } else if (process.platform === 'linux') {
    const systemctl = tryExec('systemctl --user is-active botva 2>/dev/null')
    check('systemd service', systemctl === 'active', systemctl ?? 'not found')
  }

  // PID file
  const pidPath = join(PROJECT_ROOT, 'store', 'botva.pid')
  if (existsSync(pidPath)) {
    const pid = readFileSync(pidPath, 'utf-8').trim()
    const isRunning = tryExec(`kill -0 ${pid} 2>/dev/null; echo $?`) === '0'
    check('Process running', isRunning, `PID ${pid}`)
  } else {
    check('Process running', false, 'no PID file')
  }

  console.log('')
}

main().catch(console.error)
