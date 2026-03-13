#!/bin/bash
# Send a photo to your Telegram chat from the command line
# Usage: ./scripts/send-photo.sh /path/to/image.jpg ["caption"]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Try multiple .env locations
BOT_NAME="${BOT_NAME:-default}"
if [ -f "$PROJECT_ROOT/bots/$BOT_NAME/.env" ]; then
  ENV_FILE="$PROJECT_ROOT/bots/$BOT_NAME/.env"
elif [ -f "$PROJECT_ROOT/.env" ]; then
  ENV_FILE="$PROJECT_ROOT/.env"
else
  echo "Error: .env not found"
  exit 1
fi

TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2-)
CHAT_ID=$(grep '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d'=' -f2-)

if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not set in .env"
  exit 1
fi

PHOTO_PATH="$1"
CAPTION="$2"

if [ -z "$PHOTO_PATH" ]; then
  echo "Usage: $0 /path/to/image.jpg [\"caption\"]"
  exit 1
fi

if [ ! -f "$PHOTO_PATH" ]; then
  echo "Error: File not found: $PHOTO_PATH"
  exit 1
fi

if [ -n "$CAPTION" ]; then
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendPhoto" \
    -F "chat_id=${CHAT_ID}" \
    -F "photo=@${PHOTO_PATH}" \
    -F "caption=${CAPTION}" > /dev/null
else
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendPhoto" \
    -F "chat_id=${CHAT_ID}" \
    -F "photo=@${PHOTO_PATH}" > /dev/null
fi

echo "Photo sent."
