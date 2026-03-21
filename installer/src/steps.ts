export interface Step {
  name: string
  command: string
  interactive?: boolean
  instruction?: string
  skipIf?: (params: ProvisionParams) => boolean
}

export interface ProvisionParams {
  ip: string
  password: string
  domain: string
  botToken: string
  chatId: string
  botName: string
  repoUrl: string
  adminPort: string
  mcpServers: string[]
}

function buildMcpCommands(mcpServers: string[]): string {
  if (mcpServers.length === 0) return 'echo "No MCP servers selected"'
  const installs = mcpServers.map(name => [
    `  if [ -f "mcp-servers/${name}/package.json" ]; then`,
    `    echo "${name}..."`,
    `    (cd "mcp-servers/${name}" && npm install --silent 2>/dev/null && npm run build --silent 2>/dev/null) || echo "  warning: ${name} failed"`,
    `  elif [ -f "mcp-servers/${name}/requirements.txt" ]; then`,
    `    echo "${name}..."`,
    `    (cd "mcp-servers/${name}" && python3 -m venv venv 2>/dev/null && ./venv/bin/pip install -q -r requirements.txt 2>/dev/null) || echo "  warning: ${name} failed"`,
    `  fi`,
  ].join('\n')).join('\n')

  return [
    `su - botva -c '`,
    `  ${FNM_PATH}`,
    `  cd ~/BotVa`,
    installs,
    `  echo "Done"`,
    `'`,
  ].join('\n')
}

function interpolate(template: string, params: ProvisionParams): string {
  const adminHostLine = params.domain
    ? `ADMIN_HOST=https://${params.domain}`
    : `ADMIN_HOST=http://${params.ip}:${params.adminPort}`
  return template
    .replace(/\{\{DOMAIN\}\}/g, params.domain)
    .replace(/\{\{BOT_TOKEN\}\}/g, params.botToken)
    .replace(/\{\{CHAT_ID\}\}/g, params.chatId)
    .replace(/\{\{BOT_NAME\}\}/g, params.botName)
    .replace(/\{\{REPO_URL\}\}/g, params.repoUrl)
    .replace(/\{\{ADMIN_PORT\}\}/g, params.adminPort)
    .replace(/\{\{ADMIN_HOST_LINE\}\}/g, adminHostLine)
    .replace(/\{\{MCP_INSTALL_COMMANDS\}\}/g, buildMcpCommands(params.mcpServers))
}

const FNM_PATH = 'export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/share/fnm:$PATH"'

const rawSteps: Step[] = [
  {
    name: 'Оновлення системи',
    command: [
      'echo "Waiting for apt lock..."',
      'while fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend 2>/dev/null; do sleep 2; done',
      'apt-get update -qq 2>&1 | tail -1',
      'DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq 2>&1 | tail -3',
    ].join('\n'),
  },
  {
    name: 'Системні пакети',
    command: 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl unzip build-essential python3 python3-venv jq systemd-container 2>&1 | tail -3',
  },
  {
    name: 'Swap 2GB',
    command: [
      'if ! swapon --show | grep -q /swapfile; then',
      '  fallocate -l 2G /swapfile && chmod 600 /swapfile',
      '  mkswap /swapfile >/dev/null && swapon /swapfile',
      '  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab',
      '  echo "Swap created (2GB)"',
      'else echo "Swap already exists"; fi',
    ].join('\n'),
  },
  {
    name: 'Firewall',
    command: 'ufw allow OpenSSH >/dev/null && ufw allow 80,443/tcp >/dev/null && ufw allow {{ADMIN_PORT}}/tcp >/dev/null && ufw --force enable 2>&1 | tail -1',
  },
  {
    name: 'Користувач botva',
    command: [
      'id botva &>/dev/null || adduser --disabled-password --gecos "" botva >/dev/null',
      'usermod -aG sudo botva',
      'echo "botva ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/botva',
      'chmod 440 /etc/sudoers.d/botva',
      'echo "User botva ready"',
    ].join('\n'),
  },
  {
    name: 'Node.js 22 LTS',
    command: [
      `su - botva -c '`,
      `  if command -v node &>/dev/null; then echo "Node.js already installed: $(node --version)"; exit 0; fi`,
      `  curl -fsSL https://fnm.vercel.app/install 2>/dev/null | bash -s -- --skip-shell >/dev/null 2>&1`,
      `  export PATH="$HOME/.local/share/fnm:$PATH"`,
      `  eval "$(fnm env)"`,
      `  fnm install 22 2>&1 | tail -1`,
      `  fnm use 22 >/dev/null && fnm default 22 >/dev/null`,
      `  echo "Node.js $(node --version) installed"`,
      `'`,
    ].join('\n'),
  },
  {
    name: 'Claude Code CLI',
    command: [
      `su - botva -c '`,
      `  ${FNM_PATH}`,
      `  if command -v claude &>/dev/null; then echo "Claude CLI already installed"; exit 0; fi`,
      `  npm install -g @anthropic-ai/claude-code --silent 2>&1 | tail -1`,
      `  echo "Claude Code CLI installed"`,
      `'`,
    ].join('\n'),
  },
  {
    name: 'Clone BotVa',
    command: [
      `su - botva -c '`,
      `  if [ -d ~/BotVa/.git ]; then echo "Already cloned, pulling..."; cd ~/BotVa && git pull --quiet; exit 0; fi`,
      `  git clone --quiet {{REPO_URL}} ~/BotVa`,
      `  echo "BotVa cloned"`,
      `'`,
    ].join('\n'),
  },
  {
    name: 'npm install + build',
    command: [
      `su - botva -c '`,
      `  ${FNM_PATH}`,
      `  cd ~/BotVa`,
      `  echo "Installing dependencies..."`,
      `  npm install --silent 2>&1 | tail -2`,
      `  echo "Building..."`,
      `  npm run build --silent 2>&1 | tail -1`,
      `  echo "Build complete"`,
      `'`,
    ].join('\n'),
  },
  {
    name: 'MCP сервери',
    skipIf: (p) => p.mcpServers.length === 0,
    command: '{{MCP_INSTALL_COMMANDS}}',
  },
  {
    name: 'Caddy веб-сервер',
    skipIf: (p) => !p.domain,
    command: [
      'if command -v caddy &>/dev/null; then echo "Caddy already installed"; exit 0; fi',
      'apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https 2>/dev/null',
      `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null`,
      `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list`,
      'apt-get update -qq 2>/dev/null && apt-get install -y -qq caddy 2>&1 | tail -1',
      'echo "Caddy installed"',
    ].join('\n'),
  },
  {
    name: 'Caddy HTTPS конфіг',
    skipIf: (p) => !p.domain,
    command: [
      `cat > /etc/caddy/Caddyfile <<'CADDYEOF'`,
      `{{DOMAIN}} {`,
      `    reverse_proxy localhost:{{ADMIN_PORT}}`,
      `}`,
      `CADDYEOF`,
      'systemctl enable caddy >/dev/null 2>&1 && systemctl restart caddy',
      'echo "Caddy → {{DOMAIN}}"',
    ].join('\n'),
  },
  {
    name: 'Створення бота',
    command: [
      `su - botva -c '`,
      `  cd ~/BotVa`,
      `  mkdir -p bots/{{BOT_NAME}}`,
      `  cat > bots/{{BOT_NAME}}/.env <<ENVEOF`,
      `TELEGRAM_BOT_TOKEN={{BOT_TOKEN}}`,
      `ALLOWED_CHAT_ID={{CHAT_ID}}`,
      `ENVEOF`,
      `  ADMIN_TOKEN=$(head -c 16 /dev/urandom | od -A n -t x1 | tr -d " \\n")`,
      `  cat > .env <<ENVEOF`,
      `ADMIN_PORT={{ADMIN_PORT}}`,
      `{{ADMIN_HOST_LINE}}`,
      `ADMIN_TOKEN=$ADMIN_TOKEN`,
      `ENVEOF`,
      `  echo "Admin token: $ADMIN_TOKEN"`,
      `  mkdir -p workspace/gallery workspace/logs`,
      `  echo "Bot {{BOT_NAME}} configured"`,
      `'`,
    ].join('\n'),
  },
  {
    name: 'Systemd + запуск',
    command: [
      'loginctl enable-linger botva 2>/dev/null',
      '',
      '# Use machinectl for proper user session with D-Bus',
      `machinectl shell botva@ /bin/bash -c '`,
      `  ${FNM_PATH}`,
      `  cd ~/BotVa`,
      `  bash scripts/deploy.sh systemd 2>&1 | tail -5`,
      `  echo "--- Enabling and starting services ---"`,
      `  systemctl --user daemon-reload`,
      `  for svc in ~/.config/systemd/user/botva-*.service; do`,
      `    name=$(basename $svc)`,
      `    systemctl --user enable $name 2>&1`,
      `    systemctl --user restart $name 2>&1`,
      `    echo "$name: started"`,
      `  done`,
      `  sleep 3`,
      `  systemctl --user list-units "botva-*" --no-pager`,
      `  echo ""`,
      `  echo "=== Bot logs ==="`,
      `  tail -20 ~/BotVa/workspace/logs/botva-*.log 2>/dev/null || echo "No logs yet"`,
      `  echo ""`,
      `  echo "Starting admin panel..."`,
      `  cd ~/BotVa && ADMIN_TOKEN=$(grep ADMIN_TOKEN .env | cut -d= -f2) ADMIN_PORT={{ADMIN_PORT}} node dist/admin/server.js > workspace/logs/botva-admin.log 2>&1 &`,
      `  sleep 2`,
      `  echo "Admin panel running on port {{ADMIN_PORT}}"`,
      `'`,
      'echo "Services configured and started"',
    ].join('\n'),
  },
]

export function getSteps(params: ProvisionParams): Step[] {
  return rawSteps
    .filter(step => !step.skipIf || !step.skipIf(params))
    .map(step => ({
      ...step,
      command: interpolate(step.command, params),
    }))
}
