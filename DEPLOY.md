# BotVa — Deployment Guide

## Prerequisites

- **Node.js 20+** (`node --version`)
- **macOS** or **Linux** (macOS preferred — caffeinate для sleep prevention)
- **Git**

## Quick Deploy (new machine)

```bash
# 1. Clone
git clone <repo-url> BotVa
cd BotVa

# 2. Setup (install deps, build, check config)
./scripts/deploy.sh setup

# 3. Create bots (or copy from backup)
# Each bot needs its own directory with .env and config:
mkdir -p bots/my-bot

# 4. Configure each bot
# Copy .env.example and fill in tokens:
cp .env.example bots/my-bot/.env
# Edit each .env with the correct TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID

# 5. Copy bot configs (personality, knowledge, context)
# From backup: bots/*/core/, bots/*/context/, bots/*/knowledge/
# These are NOT in git (.gitignore includes bots/)

# 6. Start
./scripts/deploy.sh start

# 7. (Optional) Auto-start on boot (macOS)
./scripts/deploy.sh launchd
```

## What's NOT in Git (must copy manually)

| Path | Content |
|------|---------|
| `bots/*/` | Bot configs, .env, personality, knowledge, SQLite DBs |
| `workspace/` | Generated images, presentations, gallery |
| `.env` | Root env (fallback for bots without own .env) |
| `.mcp.json` | MCP server configs with API tokens |
| `bots/*/store/` | SQLite databases (sessions, memories, usage) |

## Environment Variables per Bot

### Required
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `ALLOWED_CHAT_ID` | Your Telegram chat ID |

### Optional
| Variable | Description |
|----------|-------------|
| `GROQ_API_KEY` | Voice transcription (Groq) |
| `GOOGLE_API_KEY` | Image generation (Gemini) |
| `BITRIX24_WEBHOOK_URL` | CRM integration |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Workspace |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Workspace |
| `USER_GOOGLE_EMAIL` | Google account |
| `HA_URL` | Home Assistant URL |
| `HA_TOKEN` | Home Assistant token |
| `PUBLISH_SSH_HOST` | SSH host for file publishing |
| `PUBLISH_REMOTE_DIR` | Remote directory |
| `PUBLISH_BASE_URL` | Public URL |
| `ADMIN_PORT` | Admin panel port (default: 3000) |
| `ADMIN_TOKEN` | Standalone admin token (default: botva-admin-2024) |
| `LOG_LEVEL` | debug/info/warn/error |

## Bot Directory Structure

```
bots/<name>/
├── .env                    # Bot-specific tokens
├── CLAUDE.md              # AI instructions
├── core/
│   ├── personality.md     # Identity, rules
│   └── skills.md          # MCP tools, capabilities
├── context/               # User knowledge base
│   ├── user-profile.md
│   └── memories/          # Daily conversation logs
├── knowledge/             # Domain knowledge
└── store/
    └── botva.db      # SQLite (auto-created)
```

## MCP Servers

Built during `./scripts/deploy.sh setup`. Configs in:
- Root: `.mcp.json` (shared MCP servers)
- Per-bot: `bots/<name>/.mcp.json` (bot-specific)

MCP servers in `mcp-servers/`:
- **bitrix24** — CRM (also available via `npx @bitrix24/mcp-server`)
- **meta-ads-mcp** — Meta/Facebook ads management

## Management

```bash
./scripts/deploy.sh start     # Start all bots
./scripts/deploy.sh stop      # Stop all bots
./scripts/deploy.sh restart   # Restart all bots
./scripts/deploy.sh status    # Show status
./scripts/deploy.sh build     # Rebuild TypeScript
./scripts/deploy.sh launchd   # Install macOS auto-start
```

### From Telegram
- `/admin` — Launch web admin panel (on-demand, auto-stops after 20 min)
- `/admin stop` — Stop admin panel

### Admin Panel (standalone)
```bash
npm run admin   # http://localhost:3000 (always-on mode)
```

## Backup & Restore

### What to back up
```bash
tar czf botva-backup.tar.gz \
  bots/ \
  workspace/ \
  .mcp.json \
  .env
```

### Restore
```bash
cd BotVa
tar xzf botva-backup.tar.gz
./scripts/deploy.sh setup
./scripts/deploy.sh start
```
