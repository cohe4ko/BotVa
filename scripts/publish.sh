#!/bin/bash
# Publish a file, a directory or an archive to remote server (configured via PUBLISH_* env vars)
#
# Usage:
#   scripts/publish.sh /path/to/file.html [subfolder]   -> uploads single file
#   scripts/publish.sh /path/to/site/     [subfolder]   -> packs dir, unpacks it remotely
#   scripts/publish.sh /path/to/site.zip  [subfolder]   -> unpacks archive remotely
#                      (.zip | .tar.gz | .tgz | .tar)
#
# Directory/archive mode deploys the whole tree into <name>-<hash>/ on the server,
# so HTML keeps its relative links to images, CSS and JS instead of inlining base64.
# Returns: URL of the published file (index.html for directories/archives).
#
# Env (from .env or the environment):
#   PUBLISH_REMOTE_DIR  - target dir on the server (required)
#   PUBLISH_BASE_URL    - public base URL (required)
#   PUBLISH_SSH_HOST    - user@host; if empty, publishes to a local directory
#   PUBLISH_MAX_MB      - size limit for directory/archive payload (default 100)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env: BOT_DIR env var > any bot .env > project root .env
# (skipped entirely if PUBLISH_REMOTE_DIR is already provided by the environment)
if [ -z "${PUBLISH_REMOTE_DIR:-}" ]; then
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
fi

LOCAL_PATH="${1:?usage: publish.sh <file|dir|archive> [subfolder]}"
SUBFOLDER="${2:-$(date +%Y-%m-%d)}"
BASENAME=$(basename "$LOCAL_PATH")
HASH=$(date +%s%N | shasum | head -c 10)

SSH_HOST="${PUBLISH_SSH_HOST:-}"
REMOTE_DIR="${PUBLISH_REMOTE_DIR:?PUBLISH_REMOTE_DIR not set in .env}"
BASE_URL="${PUBLISH_BASE_URL:?PUBLISH_BASE_URL not set in .env}"
MAX_MB="${PUBLISH_MAX_MB:-100}"

REMOTE_PATH="$REMOTE_DIR/$SUBFOLDER"

# Transliterate Cyrillic to Latin for URL-safe names
translit() {
    echo "$1" | sed \
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
      -e 's/[^a-zA-Z0-9._-]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//'
}

# --- Detect mode: file | dir | archive ---

ARCHIVE_KIND=""
if [ -d "$LOCAL_PATH" ]; then
    MODE="dir"
elif [ -f "$LOCAL_PATH" ]; then
    MODE="file"
    case "$BASENAME" in
        *.tar.gz) MODE="archive"; ARCHIVE_KIND="targz"; STEM="${BASENAME%.tar.gz}" ;;
        *.tgz)    MODE="archive"; ARCHIVE_KIND="targz"; STEM="${BASENAME%.tgz}" ;;
        *.tar)    MODE="archive"; ARCHIVE_KIND="tar";   STEM="${BASENAME%.tar}" ;;
        *.zip)    MODE="archive"; ARCHIVE_KIND="zip";   STEM="${BASENAME%.zip}" ;;
    esac
else
    echo "Error: path not found: $LOCAL_PATH" >&2
    exit 1
fi

# --- Single file: upload as before ---

if [ "$MODE" = "file" ]; then
    EXT="${BASENAME##*.}"
    NAME=$(translit "${BASENAME%.*}")
    FILENAME="${NAME}-${HASH}.${EXT}"

    if [ -n "$SSH_HOST" ]; then
        ssh "$SSH_HOST" "mkdir -p '$REMOTE_PATH'"
        scp "$LOCAL_PATH" "$SSH_HOST:$REMOTE_PATH/$FILENAME"
    else
        mkdir -p "$REMOTE_PATH"
        cp "$LOCAL_PATH" "$REMOTE_PATH/$FILENAME"
    fi

    echo "$BASE_URL/$SUBFOLDER/$FILENAME"
    exit 0
fi

# --- Directory / archive: build a staging tree ---

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/publish.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

if [ "$MODE" = "dir" ]; then
    STAGE="${LOCAL_PATH%/}"
    NAME=$(translit "$(basename "$STAGE")")
else
    NAME=$(translit "$STEM")
    STAGE="$TMP_ROOT/stage"
    mkdir -p "$STAGE"

    # Reject absolute paths and .. traversal before unpacking
    case "$ARCHIVE_KIND" in
        zip)   ENTRIES=$(unzip -Z1 "$LOCAL_PATH") ;;
        targz) ENTRIES=$(tar -tzf "$LOCAL_PATH") ;;
        tar)   ENTRIES=$(tar -tf "$LOCAL_PATH") ;;
    esac
    if echo "$ENTRIES" | grep -qE '^/|(^|/)\.\.(/|$)'; then
        echo "Error: archive contains absolute or traversing paths, refusing to unpack" >&2
        exit 1
    fi

    case "$ARCHIVE_KIND" in
        zip)   unzip -qq "$LOCAL_PATH" -d "$STAGE" ;;
        targz) tar -xzf "$LOCAL_PATH" -C "$STAGE" ;;
        tar)   tar -xf  "$LOCAL_PATH" -C "$STAGE" ;;
    esac

    # Drop macOS zip noise
    rm -rf "$STAGE/__MACOSX"

    # Flatten wrapper directories: site.zip -> site/index.html becomes index.html
    for _ in 1 2 3; do
        [ -f "$STAGE/index.html" ] && break
        COUNT=$(find "$STAGE" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
        [ "$COUNT" = "1" ] || break
        INNER=$(find "$STAGE" -mindepth 1 -maxdepth 1)
        [ -d "$INNER" ] || break
        STAGE="$INNER"
    done
fi

if [ -z "$NAME" ]; then NAME="page"; fi
FOLDER="${NAME}-${HASH}"

# --- Size guard ---

SIZE_MB=$(du -sm "$STAGE" | cut -f1)
if [ "$SIZE_MB" -gt "$MAX_MB" ]; then
    echo "Error: payload is ${SIZE_MB}MB, limit is ${MAX_MB}MB (raise PUBLISH_MAX_MB to override)" >&2
    exit 1
fi

# --- Pick the entry point ---

ENTRY=""
if [ -f "$STAGE/index.html" ]; then
    ENTRY="index.html"
else
    HTMLS=$(find "$STAGE" -maxdepth 1 -type f -name '*.html' | head -2)
    if [ "$(echo "$HTMLS" | grep -c .)" = "1" ]; then
        ENTRY=$(basename "$HTMLS")
        echo "Warning: no index.html, using $ENTRY as entry point" >&2
    else
        echo "Warning: no index.html found, returning directory URL" >&2
    fi
fi

# --- Pack and deploy ---

BUNDLE="$TMP_ROOT/bundle.tar.gz"
# -h dereferences symlinks so nothing outside the tree leaks in as a link
tar -czhf "$BUNDLE" -C "$STAGE" .

if [ -n "$SSH_HOST" ]; then
    REMOTE_TMP="/tmp/publish-${HASH}.tar.gz"
    ssh "$SSH_HOST" "mkdir -p '$REMOTE_PATH/$FOLDER'"
    scp -q "$BUNDLE" "$SSH_HOST:$REMOTE_TMP"
    ssh "$SSH_HOST" "tar -xzf '$REMOTE_TMP' -C '$REMOTE_PATH/$FOLDER' && rm -f '$REMOTE_TMP'"
else
    mkdir -p "$REMOTE_PATH/$FOLDER"
    tar -xzf "$BUNDLE" -C "$REMOTE_PATH/$FOLDER"
fi

if [ -n "$ENTRY" ]; then
    echo "$BASE_URL/$SUBFOLDER/$FOLDER/$ENTRY"
else
    echo "$BASE_URL/$SUBFOLDER/$FOLDER/"
fi
