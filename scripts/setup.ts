import { execSync, spawnSync } from 'child_process'
import { existsSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, unlinkSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> =>
  new Promise((res) => rl.question(q, (a) => res(a.trim())))

// ANSI colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

function check(label: string, ok: boolean): void {
  console.log(ok ? green(`  ✓ ${label}`) : red(`  ✗ ${label}`))
}

async function main(): Promise<void> {
  console.log(bold(`
██████╗  ██████╗ ████████╗██╗   ██╗ █████╗
██╔══██╗██╔═══██╗╚══██╔══╝██║   ██║██╔══██╗
██████╔╝██║   ██║   ██║   ██║   ██║███████║
██╔══██╗██║   ██║   ██║   ╚██╗ ██╔╝██╔══██║
██████╔╝╚██████╔╝   ██║    ╚████╔╝ ██║  ██║
╚═════╝  ╚═════╝    ╚═╝     ╚═══╝  ╚═╝  ╚═╝

         Setup Wizard
`))

  // --- Check requirements ---
  console.log(bold('\n📋 Checking requirements...\n'))

  // Node version
  const nodeVersion = process.versions.node
  const nodeMajor = parseInt(nodeVersion.split('.')[0], 10)
  check(`Node.js ${nodeVersion}`, nodeMajor >= 20)
  if (nodeMajor < 20) {
    console.log(red('\n  Node.js 20+ is required. Please upgrade.'))
    process.exit(1)
  }

  // Claude CLI
  let claudeOk = false
  try {
    const claudeVersion = execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim()
    claudeOk = true
    check(`Claude CLI: ${claudeVersion}`, true)
  } catch {
    check('Claude CLI not found', false)
    console.log(red('\n  Install Claude Code: https://docs.anthropic.com/en/docs/claude-code'))
    process.exit(1)
  }

  // Build
  console.log(yellow('\n  Building project...'))
  const buildResult = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'pipe' })
  check('TypeScript build', buildResult.status === 0)
  if (buildResult.status !== 0) {
    console.log(red('  Build failed:'))
    console.log(buildResult.stderr?.toString() ?? '')
    process.exit(1)
  }

  // --- Collect config ---
  console.log(bold('\n🔧 Configuration\n'))

  const envValues: Record<string, string> = {}

  // Telegram token
  console.log(yellow('  To get a Telegram bot token:'))
  console.log('  1. Open Telegram and search for @BotFather')
  console.log('  2. Send /newbot')
  console.log('  3. Choose a name and username')
  console.log('  4. Copy the token\n')
  const token = await ask('  Telegram bot token: ')
  envValues['TELEGRAM_BOT_TOKEN'] = token

  // Groq API key
  console.log(yellow('\n  For voice transcription (Groq Whisper):'))
  console.log('  Get a free API key at https://console.groq.com\n')
  const groqKey = await ask('  Groq API key (Enter to skip): ')
  if (groqKey) envValues['GROQ_API_KEY'] = groqKey

  // Write .env
  console.log(bold('\n📝 Writing .env...\n'))
  const envContent = Object.entries(envValues)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\nALLOWED_CHAT_ID=\nLOG_LEVEL=info\n'
  writeFileSync(join(PROJECT_ROOT, '.env'), envContent)
  check('.env created', true)

  // Create mcp-servers.json from template
  const mcpTarget = join(PROJECT_ROOT, 'mcp-servers.json')
  const mcpTemplate = join(PROJECT_ROOT, 'mcp-servers.json.example')
  if (!existsSync(mcpTarget) && existsSync(mcpTemplate)) {
    const template = readFileSync(mcpTemplate, 'utf-8')
    writeFileSync(mcpTarget, template.replaceAll('__PROJECT_ROOT__', PROJECT_ROOT))
    check('mcp-servers.json created from template', true)
  } else if (existsSync(mcpTarget)) {
    check('mcp-servers.json already exists', true)
  }

  // Install pre-commit hook
  const hookTarget = join(PROJECT_ROOT, '.git', 'hooks', 'pre-commit')
  const hookScript = join(PROJECT_ROOT, 'scripts', 'pre-commit-check.sh')
  if (existsSync(join(PROJECT_ROOT, '.git')) && existsSync(hookScript)) {
    try {
      if (existsSync(hookTarget)) unlinkSync(hookTarget)
      symlinkSync(hookScript, hookTarget)
      check('pre-commit hook installed', true)
    } catch {
      check('pre-commit hook install failed (set manually)', false)
    }
  }

  // Create directories
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  mkdirSync(join(PROJECT_ROOT, 'workspace', 'uploads'), { recursive: true })
  check('Directories created', true)

  // Open CLAUDE.md
  const editor = process.env.EDITOR ?? 'nano'
  console.log(yellow(`\n  Opening CLAUDE.md in ${editor} for personalization...`))
  console.log('  Fill in [YOUR NAME], [YOUR ASSISTANT NAME], and your info.\n')
  const editClaudemd = await ask('  Open CLAUDE.md in editor now? (y/n): ')
  if (editClaudemd.toLowerCase() === 'y') {
    spawnSync(editor, [join(PROJECT_ROOT, 'CLAUDE.md')], { stdio: 'inherit' })
  }

  // --- Install background service (macOS) ---
  console.log(bold('\n🖥  Background Service\n'))

  const platform = process.platform
  if (platform === 'darwin') {
    const installService = await ask('  Install as launchd service (auto-start on login)? (y/n): ')
    if (installService.toLowerCase() === 'y') {
      const plistPath = join(
        process.env.HOME ?? '~',
        'Library',
        'LaunchAgents',
        'com.botva.app.plist'
      )
      const nodePath = process.execPath
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.botva.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${join(PROJECT_ROOT, 'dist', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/tmp/botva.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/botva.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${dirname(nodePath)}</string>
  </dict>
</dict>
</plist>`

      writeFileSync(plistPath, plist)
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`)
        execSync(`launchctl load "${plistPath}"`)
        check('launchd service installed and loaded', true)
      } catch {
        check('launchd service install failed', false)
        console.log(yellow(`  You can manually load it: launchctl load "${plistPath}"`))
      }
    }
  } else if (platform === 'linux') {
    const installService = await ask('  Install as systemd user service? (y/n): ')
    if (installService.toLowerCase() === 'y') {
      const serviceDir = join(process.env.HOME ?? '~', '.config', 'systemd', 'user')
      mkdirSync(serviceDir, { recursive: true })
      const servicePath = join(serviceDir, 'botva.service')
      const service = `[Unit]
Description=BotVa Bot
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${join(PROJECT_ROOT, 'dist', 'index.js')}
WorkingDirectory=${PROJECT_ROOT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
      writeFileSync(servicePath, service)
      try {
        execSync('systemctl --user daemon-reload')
        execSync('systemctl --user enable botva')
        execSync('systemctl --user start botva')
        check('systemd service installed and started', true)
      } catch {
        check('systemd service install failed', false)
      }
    }
  } else {
    console.log(yellow('  Windows detected. Use PM2 for background service:'))
    console.log('  npm install -g pm2')
    console.log(`  pm2 start ${join(PROJECT_ROOT, 'dist', 'index.js')} --name botva`)
    console.log('  pm2 save && pm2 startup')
  }

  // --- Embedding service (semantic search) ---
  console.log(bold('\n🧠 Embedding Service (Semantic Search)\n'))
  console.log('  Enables semantic search for facts (e.g. "food" finds "had borshch for lunch").\n')

  const installEmbedding = await ask('  Install embedding service? (y/n): ')
  if (installEmbedding.toLowerCase() === 'y') {
    console.log('\n  Model options:')
    console.log('    1) e5-small  — 130MB RAM, fast (default)')
    console.log('    2) e5-base   — 1.1GB RAM, better quality')
    console.log('    3) e5-large  — 2.2GB RAM, best quality\n')
    const modelChoice = await ask('  Model size [1]: ')
    const modelMap: Record<string, string> = {
      '1': 'intfloat/multilingual-e5-small',
      '2': 'intfloat/multilingual-e5-base',
      '3': 'intfloat/multilingual-e5-large',
    }
    const chosenModel = modelMap[modelChoice] ?? modelMap['1']
    // Save model choice to system settings
    const settingsPath = join(PROJECT_ROOT, 'workspace', 'system-settings.json')
    mkdirSync(join(PROJECT_ROOT, 'workspace'), { recursive: true })
    let settings: Record<string, unknown> = {}
    try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch {}
    settings.embeddingModel = chosenModel
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    console.log(green(`  Model: ${chosenModel}`))

    if (platform === 'darwin') {
      const plistPath = join(
        process.env.HOME ?? '~',
        'Library',
        'LaunchAgents',
        'com.botva.embedding.plist'
      )
      const nodePath = process.execPath
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.botva.embedding</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${join(PROJECT_ROOT, 'dist', 'scripts', 'embedding-server.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/tmp/botva-embedding.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/botva-embedding.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${dirname(nodePath)}</string>
  </dict>
</dict>
</plist>`

      writeFileSync(plistPath, plist)
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`)
        execSync(`launchctl load "${plistPath}"`)
        check('Embedding launchd service installed and loaded', true)
      } catch {
        check('Embedding launchd service install failed', false)
        console.log(yellow(`  You can manually load it: launchctl load "${plistPath}"`))
      }
    } else if (platform === 'linux') {
      const serviceDir = join(process.env.HOME ?? '~', '.config', 'systemd', 'user')
      mkdirSync(serviceDir, { recursive: true })
      const servicePath = join(serviceDir, 'botva-embedding.service')
      const service = `[Unit]
Description=BotVa Embedding Service
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${join(PROJECT_ROOT, 'dist', 'scripts', 'embedding-server.js')}
WorkingDirectory=${PROJECT_ROOT}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`
      writeFileSync(servicePath, service)
      try {
        execSync('systemctl --user daemon-reload')
        execSync('systemctl --user enable botva-embedding')
        execSync('systemctl --user start botva-embedding')
        check('Embedding systemd service installed and started', true)
      } catch {
        check('Embedding systemd service install failed', false)
      }
    } else {
      console.log(yellow('  For Windows, run manually: node dist/scripts/embedding-server.js'))
    }
  }

  // --- Get chat ID ---
  console.log(bold('\n💬 Getting your Chat ID\n'))
  console.log(yellow('  Starting bot temporarily to capture your chat ID...'))
  console.log('  1. Open Telegram')
  console.log('  2. Find your bot and send /chatid')
  console.log('  3. Copy the chat ID number and paste it here\n')

  const chatId = await ask('  Your chat ID (or press Enter to set later): ')
  if (chatId) {
    // Update .env
    const currentEnv = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8')
    writeFileSync(
      join(PROJECT_ROOT, '.env'),
      currentEnv.replace('ALLOWED_CHAT_ID=', `ALLOWED_CHAT_ID=${chatId}`)
    )
    check(`Chat ID set: ${chatId}`, true)
  } else {
    console.log(yellow('  Remember to set ALLOWED_CHAT_ID in .env later!'))
  }

  // --- Done ---
  console.log(bold('\n✅ Setup complete!\n'))
  console.log('  Next steps:')
  console.log(`  ${green('1.')} Run ${bold('npm run dev')} to test`)
  console.log(`  ${green('2.')} Send a message to your bot in Telegram`)
  console.log(`  ${green('3.')} For production: ${bold('npm run start')}`)
  console.log(`  ${green('4.')} Check status: ${bold('npm run status')}`)
  console.log(`\n  Logs: /tmp/botva.log`)
  console.log(`  Config: .env`)
  console.log(`  Personality: CLAUDE.md\n`)

  rl.close()
}

main().catch((err) => {
  console.error(red(`Setup failed: ${err}`))
  process.exit(1)
})
