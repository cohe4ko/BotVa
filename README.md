# BotVa

Multi-bot Telegram platform powered by Claude. One codebase — many bots, each with its own personality, knowledge base, memory, and integrations.

## Features

- **Multi-bot** — run multiple Telegram bots from a single instance
- **Roles** — pre-built personality templates (assistant, researcher, manager, creative, etc.)
- **Memory** — per-bot conversation history with salience-based recall
- **Voice** — speech-to-text (Groq/Whisper) and text-to-speech
- **Image generation** — via Google Gemini
- **Agent mode** — Claude agent with MCP tools for extended tasks
- **Scheduler** — cron-based recurring messages and tasks
- **Admin panel** — web UI for managing bots, memories, knowledge, and settings
- **MCP integrations** — Bitrix24 CRM, Meta Ads, inter-bot communication

## Requirements

- **Node.js 20+**
- **macOS** or **Linux**
- **Git**

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/cohe4ko/BotVa.git
cd BotVa

# 2. Run setup (installs dependencies, builds TypeScript and MCP servers)
./scripts/deploy.sh setup

# 3. Create your first bot
mkdir -p bots/my-bot
cp .env.example bots/my-bot/.env
```

Edit `bots/my-bot/.env` — fill in at minimum:

```env
TELEGRAM_BOT_TOKEN=<token from @BotFather>
ALLOWED_CHAT_ID=<your Telegram chat ID>
```

Optionally add a personality file:

```bash
mkdir -p bots/my-bot/core
# Write personality.md with the bot's character and rules
```

## Running

```bash
# Start all configured bots
./scripts/deploy.sh start

# Other commands
./scripts/deploy.sh stop       # Stop all bots
./scripts/deploy.sh restart    # Restart all bots
./scripts/deploy.sh status     # Show running bots
./scripts/deploy.sh build      # Rebuild TypeScript
./scripts/deploy.sh admin      # Launch admin panel with one-time token
./scripts/deploy.sh launchd    # Install macOS auto-start (launchd)
```

## Project Structure

```
BotVa/
├── src/                    # Platform source code (TypeScript)
│   ├── index.ts            # Entry point
│   ├── bot.ts              # Telegram bot setup
│   ├── agent.ts            # Claude agent with MCP tools
│   ├── memory.ts           # Salience-based memory system
│   ├── voice.ts            # STT/TTS
│   ├── imagen.ts           # Image generation
│   ├── scheduler.ts        # Cron scheduler
│   ├── admin/              # Web admin panel
│   └── ...
├── roles/                  # Personality templates
├── mcp-servers/            # MCP server integrations
│   ├── bitrix24/           # Bitrix24 CRM
│   ├── meta-ads-mcp/       # Meta/Facebook Ads
│   ├── colleague/          # Inter-bot communication
│   └── manager/            # Bot management tools
├── scripts/
│   └── deploy.sh           # Deploy & management script
├── bots/                   # Bot configs & data (gitignored)
│   └── <name>/
│       ├── .env            # Bot tokens & settings
│       ├── core/           # personality.md, skills.md
│       ├── context/        # User profile, daily memories
│       ├── knowledge/      # Domain knowledge files
│       └── store/          # SQLite database
├── .env.example            # Template for bot .env
└── package.json
```

## Bot Configuration

Each bot lives in `bots/<name>/` with its own `.env` file. See `.env.example` for all available options.

### Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `ALLOWED_CHAT_ID` | Your Telegram chat ID |

### Optional integrations

| Variable | Description |
|----------|-------------|
| `GOOGLE_API_KEY` | Image generation (Gemini) |
| `GROQ_API_KEY` | Voice transcription (Groq Whisper) |
| `BITRIX24_WEBHOOK_URL` | Bitrix24 CRM |
| `META_ACCESS_TOKEN` | Meta/Facebook Ads |
| `HA_URL` + `HA_TOKEN` | Home Assistant |

### Roles

Assign a role to a bot by referencing it in `core/personality.md`. Available templates in `roles/`:

`personal-assistant`, `manager`, `researcher`, `academic`, `creative`, `health-advisor`, `knowledge-base`, `planner`, `product-market`, `sales`, `webmaster`

## Admin Panel

Two ways to access:

1. **From Telegram** — send `/admin` to any bot (starts on-demand, auto-stops after 20 min)
2. **Standalone** — `npm run admin` or `./scripts/deploy.sh admin`

## Backup & Restore

Bot data is not stored in git. Back up the `bots/` directory:

```bash
# Backup
tar czf botva-backup.tar.gz bots/ workspace/ .mcp.json .env

# Restore on a new machine
git clone https://github.com/cohe4ko/BotVa.git && cd BotVa
tar xzf botva-backup.tar.gz
./scripts/deploy.sh setup
./scripts/deploy.sh start
```

## License

MIT
