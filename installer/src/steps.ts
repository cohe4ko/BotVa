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
}

const FNM_PATH = 'export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/share/fnm:$PATH"'

const rawSteps: Step[] = [
  {
    name: 'Оновлення системи',
    command: 'apt update && DEBIAN_FRONTEND=noninteractive apt upgrade -y',
  },
  {
    name: 'Системні пакети',
    command: 'apt install -y git curl unzip build-essential python3 python3-venv jq systemd-container',
  },
  {
    name: 'Swap 2GB',
    command: [
      'if ! swapon --show | grep -q /swapfile; then',
      '  fallocate -l 2G /swapfile && chmod 600 /swapfile',
      '  mkswap /swapfile && swapon /swapfile',
      '  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab',
      '  echo "Swap created"',
      'else',
      '  echo "Swap already exists"',
      'fi',
    ].join('\n'),
  },
  {
    name: 'Firewall',
    command: 'ufw allow OpenSSH && ufw allow 80,443/tcp && ufw allow {{ADMIN_PORT}}/tcp && ufw --force enable',
  },
  {
    name: 'Користувач botva',
    command: [
      'id botva &>/dev/null || adduser --disabled-password --gecos "" botva',
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
      `  curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell`,
      `  export PATH="$HOME/.local/share/fnm:$PATH"`,
      `  eval "$(fnm env)"`,
      `  fnm install 22 && fnm use 22 && fnm default 22`,
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
      `  npm install -g @anthropic-ai/claude-code`,
      `  echo "Claude Code CLI installed"`,
      `'`,
    ].join('\n'),
  },
  {
    name: 'Clone BotVa',
    command: [
      `su - botva -c '`,
      `  if [ -d ~/BotVa/.git ]; then echo "BotVa already cloned, pulling..."; cd ~/BotVa && git pull; exit 0; fi`,
      `  git clone {{REPO_URL}} ~/BotVa`,
      `  echo "BotVa cloned"`,
      `'`,
    ].join('\n'),
  },
  {
    name: 'npm install + build',
    command: [
      `su - botva -c '`,
      `  ${FNM_PATH}`,
      `  cd ~/BotVa && npm install && npm run build`,
      `  echo "Build complete"`,
      `'`,
    ].join('\n'),
  },
  {
    name: 'MCP сервери',
    command: [
      `su - botva -c '`,
      `  ${FNM_PATH}`,
      `  cd ~/BotVa`,
      `  for mcp in mcp-servers/*/; do`,
      `    [ ! -d "$mcp" ] && continue`,
      `    name=$(basename "$mcp")`,
      `    if [ -f "$mcp/package.json" ]; then`,
      `      echo "Building MCP: $name..."`,
      `      (cd "$mcp" && npm install --silent && npm run build --silent) || echo "Warning: $name build failed"`,
      `    elif [ -f "$mcp/requirements.txt" ]; then`,
      `      echo "Setting up MCP: $name..."`,
      `      (cd "$mcp" && python3 -m venv venv && ./venv/bin/pip install -q -r requirements.txt) || echo "Warning: $name setup failed"`,
      `    fi`,
      `  done`,
      `  echo "MCP servers done"`,
      `'`,
    ].join('\n'),
  },
  {
    name: 'Caddy веб-сервер',
    skipIf: (p) => !p.domain,
    command: [
      'if command -v caddy &>/dev/null; then echo "Caddy already installed"; exit 0; fi',
      'apt install -y debian-keyring debian-archive-keyring apt-transport-https',
      `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg`,
      `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list`,
      'apt update && apt install -y caddy',
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
      'systemctl enable caddy && systemctl restart caddy',
      'echo "Caddy configured for {{DOMAIN}}"',
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
      `  cat > .env <<ENVEOF`,
      `ADMIN_PORT={{ADMIN_PORT}}`,
      `{{ADMIN_HOST_LINE}}`,
      `ENVEOF`,
      `  mkdir -p workspace/gallery workspace/logs`,
      `  echo "Bot {{BOT_NAME}} configured"`,
      `'`,
    ].join('\n'),
  },
  {
    name: 'Systemd + запуск',
    command: [
      '# Enable linger so user services run without login session',
      'loginctl enable-linger botva',
      '',
      '# Set XDG_RUNTIME_DIR for systemctl --user to work via su',
      'BOTVA_UID=$(id -u botva)',
      'export XDG_RUNTIME_DIR=/run/user/$BOTVA_UID',
      '',
      '# Install systemd services and start',
      `su - botva -c '`,
      `  ${FNM_PATH}`,
      `  export XDG_RUNTIME_DIR=/run/user/$(id -u)`,
      `  cd ~/BotVa && bash scripts/deploy.sh systemd`,
      `'`,
      'echo "Services configured and started"',
    ].join('\n'),
  },
  {
    name: 'Вхід в Anthropic акаунт',
    interactive: true,
    instruction: 'Claude покаже URL для авторизації. Відкрийте цей URL у браузері, увійдіть в акаунт Anthropic і підтвердіть доступ.',
    command: `su - botva -c '${FNM_PATH} && claude login'`,
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
