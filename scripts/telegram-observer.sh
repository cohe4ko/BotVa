#!/usr/bin/env bash
# Telegram Observer daemon control.
# Usage: scripts/telegram-observer.sh {start|stop|restart|status}
#
# The daemon holds one MTProto session for the owner's account, logs messages
# per chat mode, and serves MCP tools over store/telegram.sock.

set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

PID_FILE="$DIR/store/telegram.pid"
SOCK_FILE="$DIR/store/telegram.sock"
LOG_FILE="$DIR/store/telegram-observer.log"
ENTRY="$DIR/dist/telegram/daemon.js"

if [ -f "$DIR/.env" ]; then
  set -a; source "$DIR/.env"; set +a
fi

# Source node version manager if node not in PATH (same order as deploy.sh)
if ! command -v node &>/dev/null; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  command -v fnm &>/dev/null && eval "$(fnm env)"
  for p in "$HOME/.local/bin" /usr/local/bin /usr/bin "$HOME/.npm-global/bin" "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin"; do
    [ -x "$p/node" ] && export PATH="$p:$PATH" && break
  done
fi

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

cmd_start() {
  if pid=$(running_pid); then
    echo "Вже запущений (pid $pid)"
    return 0
  fi

  if [ ! -f "$ENTRY" ]; then
    echo "ERROR: $ENTRY не знайдено. Спершу збери проєкт: scripts/deploy.sh build" >&2
    return 1
  fi

  mkdir -p "$DIR/store"
  # Stale socket from a hard kill would make the shim think we are alive.
  [ -S "$SOCK_FILE" ] && ! running_pid >/dev/null && rm -f "$SOCK_FILE"

  nohup node "$ENTRY" >> "$LOG_FILE" 2>&1 &
  local new_pid=$!
  sleep 1

  if kill -0 "$new_pid" 2>/dev/null; then
    echo "Запущено (pid $new_pid)"
  else
    echo "ERROR: не стартував. Останні рядки логу:" >&2
    tail -20 "$LOG_FILE" >&2
    return 1
  fi
}

cmd_stop() {
  if ! pid=$(running_pid); then
    echo "Не запущений"
    rm -f "$SOCK_FILE"
    return 0
  fi

  kill "$pid" 2>/dev/null
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "Не зупинився за 5с, надсилаю SIGKILL"
    kill -9 "$pid" 2>/dev/null
  fi

  rm -f "$PID_FILE" "$SOCK_FILE"
  echo "Зупинено"
}

cmd_status() {
  if pid=$(running_pid); then
    echo "running pid=$pid"
  else
    echo "stopped"
  fi
  [ -S "$SOCK_FILE" ] && echo "socket: ok" || echo "socket: absent"
  [ -f "$DIR/store/telegram.session" ] && echo "session: present" || echo "session: absent"
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
