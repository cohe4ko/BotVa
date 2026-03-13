#!/bin/bash
# Send a message to your Telegram chat from the command line
# Usage: ./scripts/notify.sh "Your message here"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env not found at $ENV_FILE"
  exit 1
fi

TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2-)
CHAT_ID=$(grep '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d'=' -f2-)

if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not set in .env"
  exit 1
fi

MESSAGE="$1"
if [ -z "$MESSAGE" ]; then
  echo "Usage: $0 \"message\""
  exit 1
fi

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "text=${MESSAGE}" \
  -d "parse_mode=HTML" > /dev/null

echo "Message sent."
