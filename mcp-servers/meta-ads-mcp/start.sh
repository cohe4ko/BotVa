#!/bin/bash
BOTVA_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Load environment variables from bot's .env
# Set BOT_NAME to your meta-ads bot name
BOT_NAME="${BOT_NAME:-default}"
set -a
source "$BOTVA_DIR/bots/$BOT_NAME/.env"
set +a

# Start the MCP server
exec node "$BOTVA_DIR/mcp-servers/meta-ads-mcp/build/index.js"
