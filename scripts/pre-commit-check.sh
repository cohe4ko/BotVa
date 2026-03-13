#!/usr/bin/env bash
# Pre-commit hook: scan staged files for secrets and personal data

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

ERRORS=0

# Get staged file contents (only added/modified, not deleted)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

STAGED_DIFF=$(git diff --cached)

check_pattern() {
  local label="$1"
  local pattern="$2"
  local matches
  matches=$(echo "$STAGED_DIFF" | grep -n "^+" | grep -Ei "$pattern" || true)
  if [ -n "$matches" ]; then
    echo -e "${RED}BLOCKED:${NC} $label"
    echo "$matches" | head -5
    echo ""
    ERRORS=$((ERRORS + 1))
  fi
}

echo "Scanning staged changes for secrets..."
echo ""

# Telegram bot tokens (patterns: digits:AAF/AAH/AAG/AAE...)
check_pattern "Telegram bot token" '[0-9]+:AA[A-Z][A-Za-z0-9_-]{30,}'

# API keys
check_pattern "Groq API key (gsk_)" 'gsk_[A-Za-z0-9]{20,}'
check_pattern "Google API key (AIzaSy)" 'AIzaSy[A-Za-z0-9_-]{30,}'
check_pattern "OpenAI/Anthropic key (sk-)" 'sk-[A-Za-z0-9]{20,}'

# Hardcoded user paths
check_pattern "Hardcoded user path (/Users/)" '/Users/[a-zA-Z]'
check_pattern "Hardcoded user path (/home/)" '/home/[a-zA-Z]'

# Email addresses (but not example.com)
check_pattern "Email address" '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'

# Webhook URLs with credentials in path
check_pattern "Webhook URL with credentials" 'https?://[^/]+/rest/[0-9]+/[a-zA-Z0-9]+'

if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}Commit blocked: $ERRORS secret pattern(s) detected.${NC}"
  echo -e "${YELLOW}Fix the issues above or use --no-verify to bypass (not recommended).${NC}"
  exit 1
fi

echo "No secrets detected. OK."
