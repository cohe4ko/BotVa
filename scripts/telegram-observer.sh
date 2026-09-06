#!/usr/bin/env bash
# Telegram Observer daemon control.
# Usage: scripts/telegram-observer.sh {start|stop|restart|status|install|uninstall}
#
# The daemon holds one MTProto session for the owner's account, logs messages
# per chat mode, and serves MCP tools over store/telegram.sock.
#
# `install` puts it under launchd so a crash or a stall-triggered exit brings it
# back on its own. Once installed, start/stop/restart go through launchctl —
# killing the process directly would only have launchd resurrect it behind us.

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

LABEL="com.botva.telegram-observer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

# Installed *and* loaded — a leftover file with no service behind it must not
# make start/stop take the launchctl path.
plist_active() {
  [ -f "$PLIST" ] && launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

cmd_install() {
  if [ ! -f "$ENTRY" ]; then
    echo "ERROR: $ENTRY не знайдено. Спершу збери проєкт: scripts/deploy.sh build" >&2
    return 1
  fi

  mkdir -p "$(dirname "$PLIST")" "$DIR/store"
  local node_bin
  node_bin=$(command -v node)

  # KeepAlive/SuccessfulExit is the whole contract: exit 0 (our SIGTERM path)
  # leaves the daemon down, exit 1 (watchdog, crash, fatal) brings it back.
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$ENTRY</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
PLIST

  # A daemon started by hand would fight the one launchd is about to start.
  if pid=$(running_pid); then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  fi
  rm -f "$SOCK_FILE"

  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null
  sleep 2

  if plist_active; then
    echo "Встановлено під launchd ($LABEL), автопідйом після збою увімкнено"
  else
    echo "ERROR: launchd не прийняв сервіс. Плист: $PLIST" >&2
    return 1
  fi
}

cmd_uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Знято з launchd (демон зупинено)"
}

cmd_start() {
  if plist_active; then
    launchctl kickstart "$DOMAIN/$LABEL" >/dev/null 2>&1
    sleep 1
    if pid=$(running_pid); then echo "Запущено через launchd (pid $pid)"; else echo "Запущено через launchd"; fi
    return 0
  fi

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
  # SIGTERM through launchctl, so the daemon exits 0 and KeepAlive lets it rest.
  if plist_active; then
    launchctl stop "$LABEL" 2>/dev/null
    for _ in $(seq 1 20); do running_pid >/dev/null || break; sleep 0.25; done
    rm -f "$SOCK_FILE"
    echo "Зупинено (launchd тримає сервіс завантаженим, але не піднімає)"
    return 0
  fi

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

cmd_restart() {
  if plist_active; then
    launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1
    sleep 2
    if pid=$(running_pid); then echo "Перезапущено через launchd (pid $pid)"; else echo "Перезапущено через launchd"; fi
    return 0
  fi
  cmd_stop
  cmd_start
}

cmd_status() {
  if pid=$(running_pid); then
    echo "running pid=$pid"
  else
    echo "stopped"
  fi
  plist_active && echo "launchd: під наглядом ($LABEL)" || echo "launchd: без нагляду — впаде і не підніметься"
  [ -S "$SOCK_FILE" ] && echo "socket: ok" || echo "socket: absent"
  [ -f "$DIR/store/telegram.session" ] && echo "session: present" || echo "session: absent"
}

case "${1:-}" in
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|install|uninstall}" >&2
    exit 1
    ;;
esac
