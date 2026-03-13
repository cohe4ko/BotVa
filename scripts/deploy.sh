#!/usr/bin/env bash
set -euo pipefail

# BotVa Deploy & Start Script
# Usage:
#   ./scripts/deploy.sh setup    — first-time setup on new machine
#   ./scripts/deploy.sh start    — start all bots
#   ./scripts/deploy.sh stop     — stop all bots
#   ./scripts/deploy.sh restart  — restart all bots
#   ./scripts/deploy.sh status   — show bot status
#   ./scripts/deploy.sh build    — rebuild TypeScript + MCP servers
#   ./scripts/deploy.sh launchd  — install macOS launchd services
#   ./scripts/deploy.sh backup   — create backup (bot or full system)
#   ./scripts/deploy.sh restore  — restore from backup
#   ./scripts/deploy.sh backups  — list available backups

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Prevent OOM on Node 25+ (use half of system RAM for V8 heap)
MEM_MB=$(node -e "console.log(Math.floor(require('os').totalmem()/1024/1024/2))")
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$MEM_MB"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }

BOTS=()
for d in bots/*/; do
  [ -d "$d" ] && BOTS+=("$(basename "$d")")
done

# ---- Functions ----

do_setup() {
  echo -e "${BOLD}BotVa — First-time Setup${NC}\n"

  # Node check
  NODE_VER=$(node --version 2>/dev/null || echo "none")
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
    err "Node.js 20+ required (found: $NODE_VER)"
    echo "  Install: https://nodejs.org or 'brew install node'"
    exit 1
  fi
  info "Node.js $NODE_VER"
  if [ "$NODE_MAJOR" -ge 25 ] 2>/dev/null; then
    echo -e "\n  ${RED}${BOLD}⚠ WARNING: Node.js $NODE_VER has known memory issues with TypeScript.${NC}"
    echo -e "  ${RED}MCP server builds may be extremely slow or crash with OOM.${NC}"
    echo -e "  ${RED}Recommended: switch to Node.js 22 LTS:${NC}"
    echo -e "  ${RED}  brew install node@22 && brew link --overwrite node@22${NC}\n"
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
      bitrix24)     echo "Bitrix24 CRM — leads, contacts, deals, companies" ;;
      meta-ads-mcp) echo "Meta Ads — Facebook/Instagram ad campaigns" ;;
      colleague)    echo "Inter-bot communication via Unix sockets" ;;
      manager)      echo "Manager bot coordination tools" ;;
      pubmed)       echo "PubMed article search & analysis (Python)" ;;
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
    read -rp "Which MCP servers to install? [numbers / a=all / s=skip, default: a]: " mcp_choice
    mcp_choice="${mcp_choice:-a}"

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
  npm run build
  info "Build complete"
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
  local port="${ADMIN_PORT:-3000}"

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

  ADMIN_TOKEN="$token" ADMIN_PORT="$port" node dist/admin/server.js > /tmp/botva-admin.log 2>&1 &
  local admin_pid=$!
  sleep 1

  if kill -0 "$admin_pid" 2>/dev/null; then
    local url="http://localhost:${port}/?token=${token}"
    info "Admin panel started (PID $admin_pid)"
    echo ""
    echo -e "  ${BOLD}Open in browser:${NC}"
    echo -e "  ${GREEN}${url}${NC}"
    echo ""
    echo "  Log: /tmp/botva-admin.log"
    echo "  Stop: kill $admin_pid"

    # Auto-open in browser
    if command -v open &>/dev/null; then
      open "$url"
    elif command -v xdg-open &>/dev/null; then
      xdg-open "$url"
    fi
  else
    err "Admin panel failed to start — check /tmp/botva-admin.log"
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
    pid=$(get_pid "$bot")
    if is_alive "$pid"; then
      warn "$bot already running (PID $pid)"
      continue
    fi
    BOT_NAME="$bot" node dist/index.js > "/tmp/botva-$bot.log" 2>&1 &
    sleep 1
    new_pid=$(get_pid "$bot")
    if is_alive "$new_pid"; then
      info "$bot started (PID $new_pid)"
    else
      err "$bot failed to start — check /tmp/botva-$bot.log"
    fi
  done

  echo -e "\nLogs: tail -f /tmp/botva-{$(IFS=,; echo "${BOTS[*]}")}.log"
}

do_stop() {
  echo -e "${BOLD}Stopping BotVa bots...${NC}"

  for bot in "${BOTS[@]}"; do
    pid=$(get_pid "$bot")
    if is_alive "$pid"; then
      kill "$pid" 2>/dev/null
      info "$bot stopped (PID $pid)"
    else
      warn "$bot not running"
    fi
  done
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

  # Admin panel
  if [ -f "workspace/admin.lock" ]; then
    admin_port=$(python3 -c "import json; print(json.load(open('workspace/admin.lock'))['port'])" 2>/dev/null || echo "?")
    echo -e "\nAdmin panel: ${GREEN}running${NC} on port $admin_port"
  else
    echo -e "\nAdmin panel: ${RED}stopped${NC} (use /admin in Telegram)"
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

    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$DIR/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_NAME</key>
    <string>$bot</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/tmp/botva-$bot.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/botva-$bot.log</string>
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

# ---- Main ----

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
  backup)   do_backup "${2:-}" ;;
  restore)  shift; do_restore "$@" ;;
  backups)  do_list_backups ;;
  *)
    echo "Usage: $0 {setup|build|start|stop|restart|status|admin|launchd|backup|restore|backups}"
    echo ""
    echo "  setup    — first-time install (deps, build, check config)"
    echo "  build    — rebuild TypeScript"
    echo "  start    — start all bots (or admin panel if no bots)"
    echo "  stop     — stop all bots"
    echo "  restart  — stop + start all bots"
    echo "  status   — show running bots"
    echo "  admin    — start admin panel with one-time token"
    echo "  launchd  — install macOS auto-start services"
    echo "  backup   — create backup [bot-name] (or full system)"
    echo "  restore  — restore from backup file"
    echo "  backups  — list available backups"
    ;;
esac
