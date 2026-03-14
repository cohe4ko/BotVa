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
    if [ -f "$envfile" ]; then
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
FILENAME="${NAME}-${HASH}.${EXT}"

SSH_HOST="${PUBLISH_SSH_HOST:?PUBLISH_SSH_HOST not set in .env}"
REMOTE_DIR="${PUBLISH_REMOTE_DIR:?PUBLISH_REMOTE_DIR not set in .env}"
BASE_URL="${PUBLISH_BASE_URL:?PUBLISH_BASE_URL not set in .env}"

REMOTE_PATH="$REMOTE_DIR/$SUBFOLDER"

if [ ! -f "$LOCAL_FILE" ]; then
    echo "Error: file not found: $LOCAL_FILE" >&2
    exit 1
fi

ssh "$SSH_HOST" "mkdir -p $REMOTE_PATH"
scp "$LOCAL_FILE" "$SSH_HOST:$REMOTE_PATH/$FILENAME"

echo "$BASE_URL/$SUBFOLDER/$FILENAME"
