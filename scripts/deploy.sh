#!/usr/bin/env bash
set -eo pipefail

# BotVa Deploy & Start Script
# Usage:
#   ./scripts/deploy.sh setup    — first-time setup on new machine
#   ./scripts/deploy.sh start    — start all bots
#   ./scripts/deploy.sh stop     — stop all bots
#   ./scripts/deploy.sh restart  — restart all bots
#   ./scripts/deploy.sh status   — show bot status
#   ./scripts/deploy.sh build    — rebuild TypeScript + MCP servers
#   ./scripts/deploy.sh launchd  — install macOS launchd services
#   ./scripts/deploy.sh systemd  — install Linux systemd services
#   ./scripts/deploy.sh embedding-start — start embedding service (semantic search)
#   ./scripts/deploy.sh embedding-stop  — stop embedding service
#   ./scripts/deploy.sh backup   — create backup (bot or full system)
#   ./scripts/deploy.sh restore  — restore from backup
#   ./scripts/deploy.sh backups  — list available backups

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
mkdir -p "$DIR/workspace/logs"

# Load root .env (ADMIN_HOST, ADMIN_PORT, etc.)
if [ -f "$DIR/.env" ]; then
  set -a; source "$DIR/.env"; set +a
fi

# Source node version manager if node not in PATH
if ! command -v node &>/dev/null; then
  # Try nvm
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  # Try fnm
  command -v fnm &>/dev/null && eval "$(fnm env)"
  [ -s "$HOME/.fnm/fnm" ] && eval "$($HOME/.fnm/fnm env)"
  # Try common paths
  for p in /usr/local/bin /usr/bin "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin"; do
    [ -x "$p/node" ] && export PATH="$p:$PATH" && break
  done
fi

# For non-setup commands, node must already be installed
if ! command -v node &>/dev/null && [ "${1:-}" != "setup" ]; then
  echo "ERROR: node not found. Run './scripts/deploy.sh setup' first or install Node.js: https://nodejs.org" >&2
  exit 1
fi

# Prevent OOM on Node 25+ (use half of system RAM for V8 heap)
if command -v node &>/dev/null; then
  MEM_MB=$(node -e "console.log(Math.floor(require('os').totalmem()/1024/1024/2))")
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$MEM_MB"
fi

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }

# Telegram notification for deploy events (uses NOTIFY_BOT_TOKEN/NOTIFY_CHAT_ID from .env)
notify_telegram() {
  local msg="$1"
  [ -z "${NOTIFY_BOT_TOKEN:-}" ] || [ -z "${NOTIFY_CHAT_ID:-}" ] && return 0
  curl -s -X POST "https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${NOTIFY_CHAT_ID}" \
    -d "text=${msg}" \
    -d "parse_mode=HTML" > /dev/null 2>&1 || true
}

BOTS=()
for d in bots/*/; do
  [ -d "$d" ] && BOTS+=("$(basename "$d")")
done

# ---- Functions ----

do_setup() {
  echo -e "${BOLD}BotVa — First-time Setup${NC}\n"

  # Node check — install if missing
  NODE_VER=$(node --version 2>/dev/null || echo "none")
  if [ "$NODE_VER" = "none" ]; then
    warn "Node.js not found. Installing Node.js 22 LTS via fnm..."
    if ! command -v fnm &>/dev/null; then
      # Install unzip if missing (required by fnm)
      if ! command -v unzip &>/dev/null; then
        echo "  Installing unzip..."
        if command -v apt-get &>/dev/null; then
          sudo apt-get update -qq && sudo apt-get install -y -qq unzip
        elif command -v yum &>/dev/null; then
          sudo yum install -y unzip
        fi
      fi
      curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
      export PATH="$HOME/.local/share/fnm:$HOME/.fnm:$PATH"
      eval "$(fnm env)"
    fi
    fnm install 22
    fnm use 22
    fnm default 22
    eval "$(fnm env)"
    NODE_VER=$(node --version 2>/dev/null || echo "none")
    if [ "$NODE_VER" = "none" ]; then
      err "Failed to install Node.js"
      exit 1
    fi
    info "Node.js $NODE_VER installed"
  fi

  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
    err "Node.js 20+ required (found: $NODE_VER)"
    echo "  Upgrade: fnm install 22 && fnm use 22 && fnm default 22"
    exit 1
  fi
  info "Node.js $NODE_VER"
  if [ "$NODE_MAJOR" -ge 25 ] 2>/dev/null; then
    echo -e "\n  ${RED}${BOLD}⚠ WARNING: Node.js $NODE_VER has known memory issues with TypeScript.${NC}"
    echo -e "  ${RED}MCP server builds may be extremely slow or crash with OOM.${NC}"
    echo -e "  ${RED}Recommended: switch to Node.js 22 LTS:${NC}"
    echo -e "  ${RED}  brew install node@22 && brew link --overwrite node@22${NC}\n"
  fi

  # Claude Code CLI
  if ! command -v claude &>/dev/null; then
    warn "Claude Code CLI not found. Installing..."
    npm install -g @anthropic-ai/claude-code
    if command -v claude &>/dev/null; then
      info "Claude Code CLI installed"
    else
      err "Failed to install Claude Code CLI"
      echo "  Install manually: npm install -g @anthropic-ai/claude-code"
    fi
  else
    info "Claude Code CLI $(claude --version 2>/dev/null || echo 'installed')"
  fi

  # Caddy web server (optional — for reverse proxy / HTTPS)
  if ! command -v caddy &>/dev/null; then
    if [ "${BOTVA_NONINTERACTIVE:-}" = "1" ]; then
      install_caddy="n"
    else
      echo -n "Install Caddy web server (for HTTPS/reverse proxy)? [y/N]: "
      read -r install_caddy
    fi
    if [ "$install_caddy" = "y" ] || [ "$install_caddy" = "Y" ]; then
      if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install caddy
      elif command -v apt-get &>/dev/null; then
        sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
        sudo apt-get update && sudo apt-get install -y caddy
      elif command -v yum &>/dev/null; then
        sudo yum install -y yum-plugin-copr
        sudo yum copr enable @caddy/caddy
        sudo yum install -y caddy
      else
        warn "Cannot auto-install Caddy. See: https://caddyserver.com/docs/install"
      fi
      command -v caddy &>/dev/null && info "Caddy installed" || warn "Caddy installation failed"
    fi
  else
    info "Caddy $(caddy version 2>/dev/null | head -c 20)"
  fi

  # Install deps
  echo -n "  Installing npm dependencies... "
  npm install --silent 2>&1
  info "done"

  # Build
  echo -n "  Building TypeScript... "
  npm run --silent build 2>&1
  info "done"

  # Build MCP servers
  echo -e "\n${BOLD}MCP Servers (optional integrations):${NC}"

  # Descriptions for known MCP servers
  mcp_desc() {
    case "$1" in
      colleague)    echo "Inter-bot communication via Unix sockets" ;;
      manager)      echo "Manager bot coordination tools" ;;
      *)            echo "" ;;
    esac
  }

  AVAILABLE_MCP=()
  MCP_TYPES=()
  for mcp in mcp-servers/*/; do
    name=$(basename "$mcp")
    if [ -f "$mcp/package.json" ]; then
      AVAILABLE_MCP+=("$name")
      MCP_TYPES+=("node")
    elif [ -f "$mcp/requirements.txt" ]; then
      AVAILABLE_MCP+=("$name")
      MCP_TYPES+=("python")
    fi
  done

  if [ ${#AVAILABLE_MCP[@]} -eq 0 ]; then
    warn "No MCP servers found"
  else
    echo ""
    for i in "${!AVAILABLE_MCP[@]}"; do
      desc=$(mcp_desc "${AVAILABLE_MCP[$i]}")
      printf "  %d. %s  — %s\n" "$((i+1))" "${AVAILABLE_MCP[$i]}" "$desc"
    done
    echo ""
    echo "  a. All"
    echo "  s. Skip"
    echo ""
    if [ "${BOTVA_NONINTERACTIVE:-}" = "1" ]; then
      mcp_choice="a"
    else
      read -rp "Which MCP servers to install? [numbers / a=all / s=skip, default: a]: " mcp_choice
      mcp_choice="${mcp_choice:-a}"
    fi

    if [ "$mcp_choice" = "s" ]; then
      warn "Skipping MCP servers"
    else
      if [ "$mcp_choice" = "a" ]; then
        SELECTED_MCP=("${AVAILABLE_MCP[@]}")
        SELECTED_TYPES=("${MCP_TYPES[@]}")
      else
        SELECTED_MCP=()
        SELECTED_TYPES=()
        for num in $mcp_choice; do
          idx=$((num - 1))
          if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#AVAILABLE_MCP[@]}" ]; then
            SELECTED_MCP+=("${AVAILABLE_MCP[$idx]}")
            SELECTED_TYPES+=("${MCP_TYPES[$idx]}")
          fi
        done
      fi

      echo ""
      for i in "${!SELECTED_MCP[@]}"; do
        name="${SELECTED_MCP[$i]}"
        type="${SELECTED_TYPES[$i]}"
        echo -n "  Installing $name... "
        if [ "$type" = "python" ]; then
          if (cd "mcp-servers/$name" && python3 -m venv venv 2>&1 && ./venv/bin/pip install -q -r requirements.txt 2>&1); then
            info "done"
          else
            err "failed (check mcp-servers/$name/)"
          fi
        else
          if (cd "mcp-servers/$name" && npm install --silent 2>&1 && npm run --silent build 2>&1); then
            info "done"
          else
            err "failed (check mcp-servers/$name/)"
          fi
        fi
      done
    fi
  fi

  # Check bots directory
  if [ ${#BOTS[@]} -eq 0 ]; then
    warn "No bots configured yet. Starting admin panel for setup..."
    echo ""
    do_admin
    return
  else
    info "Found bots: ${BOTS[*]}"
    echo ""
    for bot in "${BOTS[@]}"; do
      if [ -f "bots/$bot/.env" ]; then
        info "  $bot — .env exists"
      else
        warn "  $bot — .env MISSING (copy from .env.example)"
      fi
    done
  fi

  # Create workspace
  mkdir -p workspace/gallery
  info "workspace/ directories created"

  echo -e "\n${BOLD}Setup complete!${NC}"
  echo "  Start all bots:  ./scripts/deploy.sh start"
  echo "  Check status:     ./scripts/deploy.sh status"
}

do_build() {
  echo "Building TypeScript..."

  # Backup current dist/ before build
  if [ -d dist/ ]; then
    rm -rf dist.prev/
    cp -r dist/ dist.prev/
  fi

  # Build
  if npm run build; then
    info "Build complete"
    # Mark deploy time for probation window (used by start-bot-safe.sh)
    date +%s > dist/.deploy-timestamp
  else
    err "Build FAILED"
    if [ -d dist.prev/ ]; then
      rm -rf dist/
      mv dist.prev/ dist/
      warn "Rolled back to previous dist/"
      notify_telegram "🔴 <b>Build failed</b>. Rolled back to previous version."
    fi
    return 1
  fi
}

get_pid() {
  local bot="$1"
  local pidfile="bots/$bot/store/botva.pid"
  [ -f "$pidfile" ] && cat "$pidfile" || echo ""
}

is_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

do_admin() {
  # Check if .env already has admin settings (loaded at script start)
  local needs_save=false

  if [ -z "${ADMIN_PORT:-}" ]; then
    echo -n "Admin port [3000]: "
    read -r input_port
    ADMIN_PORT="${input_port:-3000}"
    needs_save=true
  fi
  if [ -z "${ADMIN_HOST:-}" ]; then
    echo -n "Admin host URL (e.g. https://admin.example.com) [http://localhost:${ADMIN_PORT}]: "
    read -r input_host
    ADMIN_HOST="${input_host:-http://localhost:${ADMIN_PORT}}"
    needs_save=true
  fi

  # Save to root .env only if we asked the user for new values
  if [ "$needs_save" = true ]; then
    local save_env=""
    echo -n "Save ADMIN_PORT/ADMIN_HOST to .env? [Y/n]: "
    read -r save_env
    if [ "$save_env" != "n" ] && [ "$save_env" != "N" ]; then
      [ -f "$DIR/.env" ] && sed -i.bak '/^ADMIN_PORT=/d; /^ADMIN_HOST=/d' "$DIR/.env" && rm -f "$DIR/.env.bak"
      echo "ADMIN_PORT=${ADMIN_PORT}" >> "$DIR/.env"
      [ -n "${ADMIN_HOST:-}" ] && echo "ADMIN_HOST=${ADMIN_HOST}" >> "$DIR/.env"
      info "Saved to .env"
    fi
  fi

  local port="${ADMIN_PORT}"

  # Kill everything on this port
  local pids
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    warn "Stopping processes on port $port"
    echo "$pids" | xargs kill -9 2>/dev/null
    sleep 2
  fi

  local token
  token=$(head -c 16 /dev/urandom | xxd -p)

  ADMIN_TOKEN="$token" ADMIN_PORT="$port" ADMIN_HOST="${ADMIN_HOST:-}" node dist/admin/server.js > $DIR/workspace/logs/botva-admin.log 2>&1 &
  local admin_pid=$!
  sleep 1

  if kill -0 "$admin_pid" 2>/dev/null; then
    local base_url
    if [ -n "${ADMIN_HOST:-}" ]; then
      base_url="${ADMIN_HOST}"
    else
      base_url="http://localhost:${port}"
    fi
    local url="${base_url}/?token=${token}"
    info "Admin panel started (PID $admin_pid)"
    echo ""
    echo -e "  ${BOLD}Open in browser:${NC}"
    echo -e "  ${GREEN}${url}${NC}"
    echo ""
    echo "  Log: $DIR/workspace/logs/botva-admin.log"
    echo "  Stop: kill $admin_pid"

    # Auto-open in browser
    if command -v open &>/dev/null; then
      open "$url"
    elif command -v xdg-open &>/dev/null; then
      xdg-open "$url"
    fi
  else
    err "Admin panel failed to start — check $DIR/workspace/logs/botva-admin.log"
  fi
}

do_start() {
  echo -e "${BOLD}Starting BotVa...${NC}"
  npm run build 2>/dev/null || true

  # No bots yet — launch admin panel for initial setup
  if [ ${#BOTS[@]} -eq 0 ]; then
    warn "No bots found in bots/. Starting admin panel for setup..."
    do_admin
    return
  fi

  for bot in "${BOTS[@]}"; do
    # Check both node PID and wrapper — prevent double-start
    pid=$(get_pid "$bot")
    if is_alive "$pid"; then
      warn "$bot already running (PID $pid)"
      continue
    fi
    # Also check for stale wrappers
    local stale
    stale=$(pgrep -f "start-bot-safe.sh $bot\$" 2>/dev/null || true)
    if [ -n "$stale" ]; then
      warn "$bot has stale wrapper(s): $stale — killing first"
      echo "$stale" | xargs kill 2>/dev/null || true
      sleep 1
    fi

    bash "$DIR/scripts/start-bot-safe.sh" "$bot" >> "$DIR/workspace/logs/botva-$bot.log" 2>&1 &
    WRAPPER_PID=$!
    # Save wrapper PID for stop command
    mkdir -p "bots/$bot/store"
    echo "$WRAPPER_PID" > "bots/$bot/store/wrapper.pid"
    sleep 2
    new_pid=$(get_pid "$bot")
    if is_alive "$new_pid"; then
      info "$bot started (PID $new_pid, wrapper $WRAPPER_PID)"
    else
      err "$bot failed to start — check $DIR/workspace/logs/botva-$bot.log"
    fi
  done

  echo -e "\nLogs: tail -f $DIR/workspace/logs/botva-{$(IFS=,; echo "${BOTS[*]}")}.log"
}

do_stop() {
  echo -e "${BOLD}Stopping BotVa bots...${NC}"

  for bot in "${BOTS[@]}"; do
    local stopped=false

    # 1. Stop wrapper by PID file
    local wrapper_pidfile="bots/$bot/store/wrapper.pid"
    if [ -f "$wrapper_pidfile" ]; then
      local wpid
      wpid=$(cat "$wrapper_pidfile")
      if is_alive "$wpid"; then
        kill "$wpid" 2>/dev/null
        info "$bot wrapper stopped (PID $wpid)"
        stopped=true
      fi
      rm -f "$wrapper_pidfile"
    fi

    # 2. Stop node process by PID file
    pid=$(get_pid "$bot")
    if is_alive "$pid"; then
      kill "$pid" 2>/dev/null
      info "$bot stopped (PID $pid)"
      stopped=true
    fi

    # 3. Kill ALL remaining wrappers for this bot (catches duplicates)
    local stale_wrappers
    stale_wrappers=$(pgrep -f "start-bot-safe.sh $bot\$" 2>/dev/null || true)
    if [ -n "$stale_wrappers" ]; then
      echo "$stale_wrappers" | xargs kill 2>/dev/null || true
      info "$bot killed stale wrappers: $stale_wrappers"
      stopped=true
    fi

    # 4. Kill ALL remaining node processes for this bot (catches zombies)
    # BOT_NAME is an env var, not visible in cmdline. Check botva.pid in bot's store.
    local bot_pidfile="bots/$bot/store/botva.pid"
    if [ -f "$bot_pidfile" ]; then
      local bpid
      bpid=$(cat "$bot_pidfile")
      if is_alive "$bpid"; then
        kill "$bpid" 2>/dev/null || true
        info "$bot killed node process from pidfile: $bpid"
        stopped=true
      fi
    fi

    if [ "$stopped" = false ]; then
      warn "$bot not running"
    fi
  done

  # 5. Kill any remaining dist/index.js processes (catches all zombies)
  local remaining
  remaining=$(pgrep -f "dist/index.js" 2>/dev/null || true)
  if [ -n "$remaining" ]; then
    warn "Killing remaining dist/index.js processes: $remaining"
    echo "$remaining" | xargs kill 2>/dev/null || true
  fi

  # 6. Wait for processes to actually exit
  sleep 1
}

do_restart() {
  do_stop
  sleep 2
  do_start
}

do_status() {
  echo -e "${BOLD}BotVa Bot Status${NC}\n"
  printf "%-12s %-8s %-8s %s\n" "BOT" "STATUS" "PID" "UPTIME"
  printf "%-12s %-8s %-8s %s\n" "---" "------" "---" "------"

  for bot in "${BOTS[@]}"; do
    pid=$(get_pid "$bot")
    if is_alive "$pid"; then
      # Get uptime from pid file mtime
      if [ -f "bots/$bot/store/botva.pid" ]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
          start_ts=$(stat -f %m "bots/$bot/store/botva.pid")
        else
          start_ts=$(stat -c %Y "bots/$bot/store/botva.pid")
        fi
        now_ts=$(date +%s)
        uptime_s=$((now_ts - start_ts))
        hours=$((uptime_s / 3600))
        mins=$(( (uptime_s % 3600) / 60 ))
        uptime="${hours}h ${mins}m"
      else
        uptime="?"
      fi
      printf "%-12s ${GREEN}%-8s${NC} %-8s %s\n" "$bot" "online" "$pid" "$uptime"
    else
      printf "%-12s ${RED}%-8s${NC} %-8s %s\n" "$bot" "offline" "-" "-"
    fi
  done

  # Embedding service
  local emb_pid=""
  [ -f "store/embedding.pid" ] && emb_pid=$(cat "store/embedding.pid")
  if [ -n "$emb_pid" ] && kill -0 "$emb_pid" 2>/dev/null; then
    echo -e "\nEmbedding service: ${GREEN}running${NC} (PID $emb_pid)"
  else
    echo -e "\nEmbedding service: ${RED}stopped${NC} (use: $0 embedding-start)"
  fi

  # Admin panel (this instance)
  if [ -f "workspace/admin.lock" ]; then
    local lock_pid lock_port lock_by
    lock_pid=$(python3 -c "import json; d=json.load(open('workspace/admin.lock')); print(d.get('pid','?'))" 2>/dev/null || echo "?")
    lock_port=$(python3 -c "import json; d=json.load(open('workspace/admin.lock')); print(d.get('port','?'))" 2>/dev/null || echo "?")
    lock_by=$(python3 -c "import json; d=json.load(open('workspace/admin.lock')); print(d.get('startedBy','?'))" 2>/dev/null || echo "?")
    if kill -0 "$lock_pid" 2>/dev/null; then
      echo -e "\nAdmin panel: ${GREEN}running${NC} on port $lock_port (PID $lock_pid, started by $lock_by)"
    else
      echo -e "\nAdmin panel: ${RED}stale lock${NC} (PID $lock_pid dead). Remove: rm workspace/admin.lock"
    fi
  else
    echo -e "\nAdmin panel: ${RED}stopped${NC} (use /admin in Telegram)"
  fi

  # All admin/server.js processes on this machine
  local admin_procs
  admin_procs=$(ps aux 2>/dev/null | grep '[a]dmin/server.js' || true)
  if [ -n "$admin_procs" ]; then
    echo -e "\n${BOLD}All admin processes on this machine:${NC}"
    printf "  %-8s %-6s %s\n" "USER" "PID" "PORT"
    echo "$admin_procs" | while read -r line; do
      local auser apid aport
      auser=$(echo "$line" | awk '{print $1}')
      apid=$(echo "$line" | awk '{print $2}')
      aport=$(echo "$line" | sed -n 's/.*ADMIN_PORT=\([0-9]*\).*/\1/p')
      [ -z "$aport" ] && aport="?"
      printf "  %-8s %-6s %s\n" "$auser" "$apid" "$aport"
    done
  fi
}

do_launchd() {
  echo -e "${BOLD}Installing macOS launchd services...${NC}\n"

  NODE_PATH=$(which node)
  AGENTS_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$AGENTS_DIR"

  for bot in "${BOTS[@]}"; do
    LABEL="com.botva.bot.$bot"
    PLIST="$AGENTS_DIR/$LABEL.plist"

    BASH_PATH=$(which bash)
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BASH_PATH</string>
    <string>$DIR/scripts/start-bot-safe.sh</string>
    <string>$bot</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$DIR/workspace/logs/botva-$bot.log</string>
  <key>StandardErrorPath</key>
  <string>$DIR/workspace/logs/botva-$bot.log</string>
</dict>
</plist>
PLIST

    # Load the service
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null
    info "$bot → $LABEL (auto-start on boot)"
  done

  echo -e "\nManage:"
  echo "  launchctl list | grep botva"
  echo "  launchctl stop com.botva.bot.<name>"
  echo "  launchctl start com.botva.bot.<name>"
}

do_systemd() {
  echo -e "${BOLD}Installing Linux systemd services...${NC}\n"

  if ! command -v systemctl &>/dev/null; then
    err "systemctl not found — systemd required"
    exit 1
  fi

  NODE_PATH=$(which node)
  USER=$(whoami)
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"

  for bot in "${BOTS[@]}"; do
    UNIT="botva-$bot"
    UNIT_FILE="$UNIT_DIR/$UNIT.service"

    BASH_PATH=$(which bash)
    cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=BotVa bot: $bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$BASH_PATH $DIR/scripts/start-bot-safe.sh $bot
Restart=no
StandardOutput=append:$DIR/workspace/logs/botva-$bot.log
StandardError=append:$DIR/workspace/logs/botva-$bot.log

[Install]
WantedBy=default.target
UNIT

    systemctl --user daemon-reload
    systemctl --user enable "$UNIT" 2>/dev/null
    systemctl --user restart "$UNIT"
    info "$bot → $UNIT.service (auto-start on login)"
  done

  # Embedding service
  UNIT_FILE="$UNIT_DIR/botva-embedding.service"
  cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=BotVa embedding service
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=NODE_OPTIONS=--max-old-space-size=$MEM_MB
ExecStart=$NODE_PATH $DIR/dist/scripts/embedding-server.js
Restart=on-failure
RestartSec=10
StandardOutput=append:$DIR/workspace/logs/botva-embedding.log
StandardError=append:$DIR/workspace/logs/botva-embedding.log

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable botva-embedding 2>/dev/null
  info "embedding → botva-embedding.service"

  # Enable lingering so user services run without login
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
    warn "Enabling lingering for $USER (services run without active login)"
    sudo loginctl enable-linger "$USER" 2>/dev/null || warn "Failed to enable linger — run: sudo loginctl enable-linger $USER"
  fi

  echo -e "\nManage:"
  echo "  systemctl --user status 'botva-*'"
  echo "  systemctl --user stop botva-<name>"
  echo "  systemctl --user start botva-<name>"
  echo "  journalctl --user -u botva-<name> -f"
}

# ---- Main ----

do_embedding_start() {
  local pidfile="store/embedding.pid"
  local pid=""
  [ -f "$pidfile" ] && pid=$(cat "$pidfile")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    warn "Embedding service already running (PID $pid)"
    return
  fi
  echo "Starting embedding service..."
  mkdir -p store
  node dist/scripts/embedding-server.js > $DIR/workspace/logs/botva-embedding.log 2>&1 &
  sleep 2
  [ -f "$pidfile" ] && pid=$(cat "$pidfile")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    info "Embedding service started (PID $pid)"
    echo "  Log: $DIR/workspace/logs/botva-embedding.log"
  else
    err "Embedding service failed to start — check $DIR/workspace/logs/botva-embedding.log"
  fi
}

do_embedding_stop() {
  local pidfile="store/embedding.pid"
  local pid=""
  [ -f "$pidfile" ] && pid=$(cat "$pidfile")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    info "Embedding service stopped (PID $pid)"
  else
    warn "Embedding service not running"
  fi
}

do_backup() {
  local bot_name="${1:-}"
  if [ -n "$bot_name" ]; then
    echo "Creating backup for bot: $bot_name..."
    node dist/backup/cli.js backup --bot "$bot_name"
  else
    echo "Creating full system backup..."
    node dist/backup/cli.js backup --system
  fi
}

do_restore() {
  local file="${1:-}"
  if [ -z "$file" ]; then
    err "Usage: $0 restore <backup-file> [--overwrite]"
    exit 1
  fi
  shift
  node dist/backup/cli.js restore "$file" "$@"
}

do_list_backups() {
  node dist/backup/cli.js list
}

case "${1:-}" in
  setup)    do_setup ;;
  build)    do_build ;;
  start)    do_start ;;
  stop)     do_stop ;;
  restart)  do_restart ;;
  status)   do_status ;;
  admin)    do_admin ;;
  launchd)  do_launchd ;;
  systemd)  do_systemd ;;
  embedding-start)  do_embedding_start ;;
  embedding-stop)   do_embedding_stop ;;
  backup)   do_backup "${2:-}" ;;
  restore)  shift; do_restore "$@" ;;
  backups)  do_list_backups ;;
  *)
    echo "Usage: $0 {setup|build|start|stop|restart|status|admin|launchd|systemd|embedding-start|embedding-stop|backup|restore|backups}"
    echo ""
    echo "  setup            — first-time install (deps, build, check config)"
    echo "  build            — rebuild TypeScript"
    echo "  start            — start all bots (or admin panel if no bots)"
    echo "  stop             — stop all bots"
    echo "  restart          — stop + start all bots"
    echo "  status           — show running bots"
    echo "  admin            — start admin panel with one-time token"
    echo "  launchd          — install macOS auto-start services"
    echo "  systemd          — install Linux systemd user services"
    echo "  embedding-start  — start embedding service (semantic search)"
    echo "  embedding-stop   — stop embedding service"
    echo "  backup           — create backup [bot-name] (or full system)"
    echo "  restore          — restore from backup file"
    echo "  backups          — list available backups"
    ;;
esac
