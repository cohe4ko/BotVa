#!/usr/bin/env bash
# NOTE: no "set -e" here! The main loop uses wait which returns child's exit code.
# With set -e, a non-zero exit from wait would kill the wrapper itself.

# BotVa Crash Watchdog
# Wraps bot process with crash counting, auto-rollback, and Telegram notifications.
# Usage: bash scripts/start-bot-safe.sh <bot-name>

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

BOT="$1"
[ -z "$BOT" ] && echo "Usage: $0 <bot-name>" && exit 1

# Load root .env for NOTIFY_BOT_TOKEN / NOTIFY_CHAT_ID
if [ -f "$DIR/.env" ]; then
  NOTIFY_BOT_TOKEN=$(grep '^NOTIFY_BOT_TOKEN=' "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2)
  NOTIFY_CHAT_ID=$(grep '^NOTIFY_CHAT_ID=' "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2)
fi

# Config
CRASH_COUNT=0
MAX_CRASHES_PROBATION=3    # crashes during probation → rollback
MAX_CRASHES_TOTAL=5        # crashes total → stop
PROBATION_SECONDS=1800     # 30 min after deploy
RESTART_DELAY=3            # seconds between restarts

# Child PID for signal forwarding
CHILD_PID=0

cleanup() {
  if [ $CHILD_PID -ne 0 ]; then
    kill $CHILD_PID 2>/dev/null || true
    wait $CHILD_PID 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGTERM SIGINT

# Telegram notification (direct curl, no node dependency)
notify() {
  local msg="$1"
  [ -z "$NOTIFY_BOT_TOKEN" ] || [ -z "$NOTIFY_CHAT_ID" ] && return 0
  curl -s -X POST "https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${NOTIFY_CHAT_ID}" \
    -d "text=${msg}" \
    -d "parse_mode=HTML" > /dev/null 2>&1 || true
}

# Check if still in probation period (30 min after deploy)
is_probation() {
  local ts_file="$DIR/dist/.deploy-timestamp"
  [ ! -f "$ts_file" ] && echo "no" && return
  local deploy_time
  deploy_time=$(cat "$ts_file")
  local now
  now=$(date +%s)
  local elapsed=$((now - deploy_time))
  [ $elapsed -lt $PROBATION_SECONDS ] && echo "yes" || echo "no"
}

# Promote dist/ to dist.stable/ after probation ends (atomic lock)
promote_stable() {
  local ts_file="$DIR/dist/.deploy-timestamp"
  [ ! -f "$ts_file" ] && return

  local deploy_time
  deploy_time=$(cat "$ts_file")
  local now
  now=$(date +%s)
  local elapsed=$((now - deploy_time))
  [ $elapsed -lt $PROBATION_SECONDS ] && return

  # Atomic lock via mkdir (POSIX, works on macOS + Linux)
  local lock="$DIR/dist/.promote-lock"
  mkdir "$lock" 2>/dev/null || return

  rm -rf "$DIR/dist.stable/"
  cp -r "$DIR/dist/" "$DIR/dist.stable/"
  # Clean up artifacts that cp -r copied into stable
  rm -f "$DIR/dist.stable/.deploy-timestamp"
  rmdir "$DIR/dist.stable/.promote-lock" 2>/dev/null || true
  rm -f "$ts_file"
  rmdir "$lock" 2>/dev/null || true

  notify "✅ <b>Deploy promoted to stable</b> after $(( PROBATION_SECONDS / 60 ))m probation"
}

# Rollback dist/ from dist.stable/
rollback_to_stable() {
  if [ -d "$DIR/dist.stable/" ]; then
    rm -rf "$DIR/dist/"
    cp -r "$DIR/dist.stable/" "$DIR/dist/"
    rm -f "$DIR/dist/.deploy-timestamp"
    return 0
  fi
  return 1
}

# Source node version manager if needed
if ! command -v node &>/dev/null; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  command -v fnm &>/dev/null && eval "$(fnm env)"
  for p in /usr/local/bin /usr/bin "$HOME/.local/bin" "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin"; do
    [ -x "$p/node" ] && export PATH="$p:$PATH" && break
  done
fi

# Prevent OOM on Node 25+
if command -v node &>/dev/null; then
  MEM_MB=$(node -e "console.log(Math.floor(require('os').totalmem()/1024/1024/2))")
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$MEM_MB"
fi

# ---- Main loop ----

# Save wrapper PID so deploy.sh stop can find us
WRAPPER_PIDFILE="$DIR/bots/$BOT/store/wrapper.pid"
mkdir -p "$DIR/bots/$BOT/store"
echo $$ > "$WRAPPER_PIDFILE"

notify "🟢 <b>${BOT}</b> starting"

while true; do
  # Try to promote if probation ended
  promote_stable

  # Start bot
  BOT_NAME="$BOT" node "$DIR/dist/index.js" &
  CHILD_PID=$!

  # Background promoter: checks every 60s during probation
  (
    while kill -0 $CHILD_PID 2>/dev/null; do
      sleep 60
      promote_stable
    done
  ) &
  PROMOTER_PID=$!

  # Wait for bot to exit
  wait $CHILD_PID 2>/dev/null
  EXIT_CODE=$?
  CHILD_PID=0

  # Stop promoter
  kill $PROMOTER_PID 2>/dev/null; wait $PROMOTER_PID 2>/dev/null || true

  # Graceful shutdown (exit 0 or SIGTERM=143) → clean exit
  if [ $EXIT_CODE -eq 0 ] || [ $EXIT_CODE -eq 143 ]; then
    notify "⚪ <b>${BOT}</b> stopped gracefully"
    break
  fi

  # Intentional restart (exit 42 from /restart command) → restart without crash count
  if [ $EXIT_CODE -eq 42 ]; then
    notify "🔄 <b>${BOT}</b> restarting (requested)"
    sleep $RESTART_DELAY
    continue
  fi

  # Crash!
  CRASH_COUNT=$((CRASH_COUNT + 1))
  PROBATION=$(is_probation)

  # Probation + too many crashes → rollback
  if [ "$PROBATION" = "yes" ] && [ $CRASH_COUNT -ge $MAX_CRASHES_PROBATION ]; then
    if rollback_to_stable; then
      notify "🔴 <b>${BOT}</b> crashed ${CRASH_COUNT}x during probation. Rolled back to stable version."
      CRASH_COUNT=0
      sleep $RESTART_DELAY
      continue
    else
      notify "🔴🔴 <b>${BOT}</b> crashed ${CRASH_COUNT}x during probation. No stable version. Manual fix needed."
      break
    fi
  fi

  # Too many crashes total → give up
  if [ $CRASH_COUNT -ge $MAX_CRASHES_TOTAL ]; then
    notify "🔴🔴 <b>${BOT}</b> crashed ${CRASH_COUNT}x. Stopped. Manual intervention needed."
    break
  fi

  # Regular crash → restart
  notify "🟡 <b>${BOT}</b> crashed (exit ${EXIT_CODE}). Restarting #${CRASH_COUNT}..."
  sleep $RESTART_DELAY
done
