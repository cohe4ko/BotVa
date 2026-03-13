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

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

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

  # Install deps
  echo -e "\n${BOLD}Installing dependencies...${NC}"
  npm install
  info "npm install done"

  # Build
  echo -e "\n${BOLD}Building TypeScript...${NC}"
  npm run build
  info "Build done"

  # Build MCP servers
  echo -e "\n${BOLD}Building MCP servers...${NC}"
  for mcp in mcp-servers/*/; do
    if [ -f "$mcp/package.json" ]; then
      name=$(basename "$mcp")
      echo "  Building $name..."
      (cd "$mcp" && npm install --silent && npm run build) 2>&1
      info "MCP: $name"
    fi
  done

  # Check bots directory
  if [ ${#BOTS[@]} -eq 0 ]; then
    warn "No bots found in bots/. Create one:"
    echo "  mkdir -p bots/mybot"
    echo "  cp .env.example bots/mybot/.env"
    echo "  # Edit bots/mybot/.env with your tokens"
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
  mkdir -p workspace/uploads workspace/gallery
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
  local token
  token=$(head -c 16 /dev/urandom | xxd -p)

  ADMIN_TOKEN="$token" ADMIN_PORT="$port" node dist/admin/server.js > /tmp/botva-admin.log 2>&1 &
  local admin_pid=$!
  sleep 1

  if kill -0 "$admin_pid" 2>/dev/null; then
    info "Admin panel started (PID $admin_pid)"
    echo ""
    echo -e "  ${BOLD}Open in browser:${NC}"
    echo -e "  ${GREEN}http://localhost:${port}/?token=${token}${NC}"
    echo ""
    echo "  Log: /tmp/botva-admin.log"
    echo "  Stop: kill $admin_pid"
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

case "${1:-}" in
  setup)   do_setup ;;
  build)   do_build ;;
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  admin)   do_admin ;;
  launchd) do_launchd ;;
  *)
    echo "Usage: $0 {setup|build|start|stop|restart|status|admin|launchd}"
    echo ""
    echo "  setup    — first-time install (deps, build, check config)"
    echo "  build    — rebuild TypeScript"
    echo "  start    — start all bots (or admin panel if no bots)"
    echo "  stop     — stop all bots"
    echo "  restart  — stop + start all bots"
    echo "  status   — show running bots"
    echo "  admin    — start admin panel with one-time token"
    echo "  launchd  — install macOS auto-start services"
    ;;
esac
