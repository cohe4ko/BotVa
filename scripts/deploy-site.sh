#!/bin/bash
# Deploy site files via rsync (full) or scp (single file)
# Auto-commits changes to git before deploy for rollback capability.
# Usage:
#   scripts/deploy-site.sh              # git commit + full rsync deploy
#   scripts/deploy-site.sh path/to/file # git commit + single file via scp
#   scripts/deploy-site.sh --dry-run    # preview without changes (no commit)
#   scripts/deploy-site.sh --rollback   # revert last commit and redeploy
#   scripts/deploy-site.sh --help       # show usage

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# --- Help ---
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'USAGE'
Deploy site files to remote server. Auto-commits to git before deploy.

Usage:
  scripts/deploy-site.sh              # git commit + full rsync (--delete)
  scripts/deploy-site.sh path/to/file # git commit + single file via scp
  scripts/deploy-site.sh --dry-run    # preview changes (no commit, no upload)
  scripts/deploy-site.sh --rollback   # revert last deploy and redeploy
  scripts/deploy-site.sh --log        # show git log of site changes

Environment (from .env):
  SITE_DIR        - local site directory (e.g. ~/Sites/vika)
  SITE_SSH_HOST   - SSH host (e.g. user@server.com)
  SITE_REMOTE_DIR - remote path (e.g. /var/www/vika)
  SITE_SSH_PORT   - SSH port (default: 22)
USAGE
    exit 0
fi

# --- Load .env (same pattern as publish.sh) ---
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

# --- Validate required vars ---
SITE_DIR="${SITE_DIR:?SITE_DIR not set in .env}"
SSH_HOST="${SITE_SSH_HOST:?SITE_SSH_HOST not set in .env}"
REMOTE_DIR="${SITE_REMOTE_DIR:?SITE_REMOTE_DIR not set in .env}"
SSH_PORT="${SITE_SSH_PORT:-22}"

# Expand ~ in SITE_DIR
SITE_DIR="${SITE_DIR/#\~/$HOME}"

if [ ! -d "$SITE_DIR" ]; then
    echo "Error: SITE_DIR not found: $SITE_DIR" >&2
    exit 1
fi

# --- Git init if needed ---
if [ ! -d "$SITE_DIR/.git" ]; then
    echo "Initializing git in $SITE_DIR..."
    git -C "$SITE_DIR" init -q
    git -C "$SITE_DIR" add -A
    git -C "$SITE_DIR" commit -q -m "initial: site snapshot"
    echo "Git initialized with initial commit"
fi

# --- --log: show history ---
if [[ "${1:-}" == "--log" ]]; then
    git -C "$SITE_DIR" log --oneline -20
    exit 0
fi

# --- --rollback: revert last commit and redeploy ---
if [[ "${1:-}" == "--rollback" ]]; then
    LAST_MSG=$(git -C "$SITE_DIR" log -1 --format="%h %s")
    echo "Rolling back: $LAST_MSG"
    git -C "$SITE_DIR" revert --no-edit HEAD
    echo "Reverted. Redeploying..."
    # Re-run self without --rollback for full deploy
    exec "$0"
fi

# --- Dry run ---
DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN="--dry-run"
    echo "=== DRY RUN (no changes will be made) ==="
    shift
fi

# --- Git commit before deploy ---
if [ -z "$DRY_RUN" ]; then
    cd "$SITE_DIR"
    if ! git -C "$SITE_DIR" diff --quiet || ! git -C "$SITE_DIR" diff --cached --quiet || [ -n "$(git -C "$SITE_DIR" ls-files --others --exclude-standard)" ]; then
        git -C "$SITE_DIR" add -A
        TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
        git -C "$SITE_DIR" commit -q -m "deploy: $TIMESTAMP"
        echo "Git: committed changes ($TIMESTAMP)"
    else
        echo "Git: no changes to commit"
    fi
fi

# --- Deploy ---
if [ -n "${1:-}" ]; then
    # Single file via scp
    FILE="$1"
    if [[ "$FILE" != /* ]]; then
        FILE="$SITE_DIR/$FILE"
    fi

    if [ ! -f "$FILE" ]; then
        echo "Error: file not found: $FILE" >&2
        exit 1
    fi

    # Get relative path for remote destination
    REL_PATH="${FILE#$SITE_DIR/}"
    REMOTE_PATH="$REMOTE_DIR/$REL_PATH"
    REMOTE_PARENT=$(dirname "$REMOTE_PATH")

    if [ -n "$DRY_RUN" ]; then
        echo "Would upload: $FILE -> $SSH_HOST:$REMOTE_PATH"
    else
        echo "Uploading: $REL_PATH"
        ssh -p "$SSH_PORT" "$SSH_HOST" "mkdir -p '$REMOTE_PARENT'"
        scp -P "$SSH_PORT" "$FILE" "$SSH_HOST:$REMOTE_PATH"
        echo "Done: $REL_PATH deployed"
    fi
else
    # Full rsync
    echo "Syncing $SITE_DIR -> $SSH_HOST:$REMOTE_DIR"
    rsync -avz --delete \
        --exclude '.DS_Store' \
        --exclude '*.bak' \
        -e "ssh -p $SSH_PORT" \
        $DRY_RUN \
        "$SITE_DIR/" "$SSH_HOST:$REMOTE_DIR/"
    echo "Done: full deploy complete"
fi
