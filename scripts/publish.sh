#!/bin/bash
# Publish a file to remote server (configured via PUBLISH_* env vars)
# Usage: scripts/publish.sh /local/path/to/file.html [subfolder]
# Returns: URL of the published file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env: BOT_DIR env var > any bot .env > project root .env
ENV_CANDIDATES=()
[ -n "${BOT_DIR:-}" ] && ENV_CANDIDATES+=("$BOT_DIR/.env")
for d in "$PROJECT_DIR"/bots/*/.env; do ENV_CANDIDATES+=("$d"); done
ENV_CANDIDATES+=("$PROJECT_DIR/.env")

for envfile in "${ENV_CANDIDATES[@]}"; do
    if [ -f "$envfile" ] && grep -q 'PUBLISH_REMOTE_DIR' "$envfile" 2>/dev/null; then
        set -a
        source "$envfile"
        set +a
        break
    fi
done

LOCAL_FILE="$1"
SUBFOLDER="${2:-$(date +%Y-%m-%d)}"
BASENAME=$(basename "$LOCAL_FILE")
HASH=$(date +%s%N | shasum | head -c 10)
EXT="${BASENAME##*.}"
NAME="${BASENAME%.*}"

# Transliterate Cyrillic to Latin for URL-safe filenames
NAME=$(echo "$NAME" | sed \
  -e 's/А/A/g' -e 's/а/a/g' -e 's/Б/B/g' -e 's/б/b/g' \
  -e 's/В/V/g' -e 's/в/v/g' -e 's/Г/H/g' -e 's/г/h/g' \
  -e 's/Ґ/G/g' -e 's/ґ/g/g' -e 's/Д/D/g' -e 's/д/d/g' \
  -e 's/Е/E/g' -e 's/е/e/g' -e 's/Є/Ye/g' -e 's/є/ye/g' \
  -e 's/Ж/Zh/g' -e 's/ж/zh/g' -e 's/З/Z/g' -e 's/з/z/g' \
  -e 's/И/Y/g' -e 's/и/y/g' -e 's/І/I/g' -e 's/і/i/g' \
  -e 's/Ї/Yi/g' -e 's/ї/yi/g' -e 's/Й/Y/g' -e 's/й/y/g' \
  -e 's/К/K/g' -e 's/к/k/g' -e 's/Л/L/g' -e 's/л/l/g' \
  -e 's/М/M/g' -e 's/м/m/g' -e 's/Н/N/g' -e 's/н/n/g' \
  -e 's/О/O/g' -e 's/о/o/g' -e 's/П/P/g' -e 's/п/p/g' \
  -e 's/Р/R/g' -e 's/р/r/g' -e 's/С/S/g' -e 's/с/s/g' \
  -e 's/Т/T/g' -e 's/т/t/g' -e 's/У/U/g' -e 's/у/u/g' \
  -e 's/Ф/F/g' -e 's/ф/f/g' -e 's/Х/Kh/g' -e 's/х/kh/g' \
  -e 's/Ц/Ts/g' -e 's/ц/ts/g' -e 's/Ч/Ch/g' -e 's/ч/ch/g' \
  -e 's/Ш/Sh/g' -e 's/ш/sh/g' -e 's/Щ/Shch/g' -e 's/щ/shch/g' \
  -e "s/Ь//g" -e "s/ь//g" -e "s/Ъ//g" -e "s/ъ//g" \
  -e 's/Ю/Yu/g' -e 's/ю/yu/g' -e 's/Я/Ya/g' -e 's/я/ya/g' \
  -e 's/Ы/Y/g' -e 's/ы/y/g' -e 's/Э/E/g' -e 's/э/e/g' \
  -e 's/[^a-zA-Z0-9._-]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//')

FILENAME="${NAME}-${HASH}.${EXT}"

SSH_HOST="${PUBLISH_SSH_HOST:-}"
REMOTE_DIR="${PUBLISH_REMOTE_DIR:?PUBLISH_REMOTE_DIR not set in .env}"
BASE_URL="${PUBLISH_BASE_URL:?PUBLISH_BASE_URL not set in .env}"

REMOTE_PATH="$REMOTE_DIR/$SUBFOLDER"

if [ ! -f "$LOCAL_FILE" ]; then
    echo "Error: file not found: $LOCAL_FILE" >&2
    exit 1
fi

if [ -n "$SSH_HOST" ]; then
    # Remote: upload via SSH
    ssh "$SSH_HOST" "mkdir -p $REMOTE_PATH"
    scp "$LOCAL_FILE" "$SSH_HOST:$REMOTE_PATH/$FILENAME"
else
    # Local: copy to directory on this machine
    mkdir -p "$REMOTE_PATH"
    cp "$LOCAL_FILE" "$REMOTE_PATH/$FILENAME"
fi

echo "$BASE_URL/$SUBFOLDER/$FILENAME"
