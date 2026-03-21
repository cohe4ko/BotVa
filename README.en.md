# BotVa

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org)

[🇺🇦 Українська](README.md)

Multi-bot Telegram platform powered by Claude AI. One server — many bots, each with its own role, memory, knowledge, and integrations.

## What Makes BotVa Different

- **Memory as a first-class entity.** SQLite with a salience model (facts decay at 0.98/day, reinforced on access) + daily markdown digests. At 4 AM the bot summarizes the day via Claude and updates KEY_EVENTS.md
- **Bot team.** Bots communicate via Unix sockets (Colleague MCP), a manager distributes tasks in parallel. Recursion protection on delegation
- **Full isolation.** Each bot has its own .env, database, knowledge, memory, voice, and role. All run from a single process and are managed from one admin panel
- **Live management.** Web panel for creating bots, editing .env, image gallery, cron tasks, backups, diagnostics — no restarts needed
- **Dynamic integrations.** MCP servers connect based on env variables — add `BITRIX24_WEBHOOK_URL` and the bot gets CRM. No code changes
- **Philosophy.** The base role (`_soul.md`) is a manifesto: how to think, how to communicate, when to stay silent. Not "certainly!", but a human conversation

## Key Features

- **Multiple bots** from a single Node.js instance
- **13 ready-made roles** — from personal assistant to webmaster
- **Memory** — facts (long-term storage) + daily diary logs with consolidation
- **Voice** — voice messages and responses (Groq STT + Edge TTS)
- **Images** — generation and editing via Gemini with auto-gallery
- **Gemini AI** — second opinion (AskGemini) and search with citations (GeminiSearch)
- **Bot team** — communication via Unix sockets, task delegation
- **Scheduler** — cron tasks with full tool access
- **Utilities** — currency rates, time, Python sandbox, email, Telegraph
- **Integrations** — CRM, ads, Google Workspace, smart home, PubMed
- **Web search** — search, scraping, AI browser (Stagehand)
- **Admin panel** — full web interface for management
- **Backups** — full and per-bot, with SHA256 verification

## Quick Start

### Requirements

- Node.js 20+
- macOS or Linux
- Git

### Installation

```bash
# 1. Clone
git clone https://github.com/cohe4ko/BotVa.git BotVa
cd BotVa

# 2. Install dependencies and build
./scripts/deploy.sh setup

# 3. Create your first bot (option A: CLI)
npm run new-bot -- my-bot personal-assistant --emoji 🧑‍💼 --name "My Bot"

# 3. Create your first bot (option B: web interface)
npm run admin              # Start admin panel
#    Open http://localhost:3000 → Create Bot

# 4. Configure tokens
#    Edit bots/my-bot/.env:
#    - TELEGRAM_BOT_TOKEN  (get from @BotFather in Telegram)
#    - ALLOWED_CHAT_ID     (send /chatid to the bot after starting)

# 5. Start
./scripts/deploy.sh start
```

After starting, message your bot in Telegram — it will respond.

## Bot Roles

When creating a bot you choose a role — it defines specialization, tools, and style.

| Role | Slug | Description |
|------|------|-------------|
| Personal Assistant | `personal-assistant` | Daily tasks, calendar, CRM, smart home |
| Researcher | `researcher` | Deep analysis, fact verification, reports |
| Health | `health-advisor` | Health metrics monitoring, lab results, recommendations |
| Academic | `academic` | Scientific papers, methodology, PhD, teaching |
| Creative | `creative` | Design, images, presentations, copywriting |
| Sales | `sales` | Leads, deals, sales analysis, proposals |
| Planner | `planner` | Tasks, deadlines, prioritization |
| Knowledge Base | `knowledge-base` | Documentation, FAQ, knowledge search |
| Manager | `manager` | Bot team coordination, task delegation |
| Product/Market | `product-market` | CRM analytics, positioning, competitors |
| Webmaster | `webmaster` | Website, content, deploy, SEO |
| Smart Home Engineer | `dome-engineer` | Automation, scenarios, Home Assistant |
| Debate Researcher | `debate-researcher` | Analysis from opposing perspectives |

```bash
npm run new-bot -- <slug> <role> [--emoji 🤖] [--name "Name"]
```

## Features

### Voice

The bot understands voice messages and can respond with voice. STT via Groq Whisper (requires `GROQ_API_KEY`), TTS via Edge-TTS (free). The `/voice` command toggles voice responses.

### Images

Generation and editing via Gemini (`GOOGLE_API_KEY`). Use `/img description` or just ask in chat. All images are saved to the gallery.

### Memory

Three-tier system: facts (persistent storage with topics and tags), daily markdown logs, workspace files (USER.md, MEMORY.md). Consolidation at `NIGHT_OWL_HOUR`.

### Scheduler

Cron tasks: `/schedule 0 9 * * * What's on my agenda today?`. Standard 5-field cron.

### Bot Team

A manager coordinates work, bots communicate via Colleague MCP (Unix sockets). Each bot can reach the manager via `ask_manager()`.

### Telegram

SendMedia (photos, documents, albums), ForwardMessage, SetReaction, PinMessage, OpenWebApp (Mini App), AskUser (buttons, polls).

### Utilities

CurrencyRates (cash exchange rates), GetCurrentTime, RunPython (sandbox), SendEmail (SMTP), PublishTelegraph.

### Workspace Files

The bot reads and updates its files between sessions: USER.md (profile), MEMORY.md (memory) via ReadWorkspaceFile / WriteWorkspaceFile.

Detailed guide: [MANUAL.md](MANUAL.md)

## Integrations

| Integration | MCP Server | Required Variables |
|-------------|-----------|-------------------|
| Bitrix24 CRM | `bitrix24` | `BITRIX24_WEBHOOK_URL` |
| Meta/Facebook Ads | `meta-ads-mcp` | `META_ACCESS_TOKEN`, `META_APP_SECRET` |
| Google Calendar, Gmail, Drive | `google-workspace` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| Home Assistant | `home-assistant` | `HA_URL`, `HA_TOKEN` |
| PubMed (medical research) | `pubmed` | — (Python 3) |
| Miro (boards, diagrams) | `miro` | — (remote HTTP, OAuth) |

## Admin Panel

Web interface for bot management. Two ways to start:

```bash
# 1. From Telegram (on-demand, auto-stops after 20 min)
/admin

# 2. As a standalone service (persistent)
npm run admin
```

| Section | Description |
|---------|-------------|
| Dashboard | Bot status, requests, costs, services |
| Config | Model, temperature, env variables, workspace files |
| Knowledge | Bot knowledge files |
| Facts | Memory: view, search, edit |
| Tasks | Scheduled cron tasks |
| Settings | Chat settings, sessions |
| Usage | Token analytics and costs |
| System | Builtin tools, MCP servers, skills on/off |
| Images | Generated image gallery |
| Logs | Event audit log |
| Diagnostics | AI-powered system diagnostics |
| Backup | Create and restore backups |
| Team | Bot team management |
| Templates | Role templates |
| Terminal | Browser shell |
| Create Bot | New bot creation wizard |

Detailed guide: [MANUAL.md](MANUAL.md)

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Greeting and chat ID |
| `/chatid` | Show chat ID |
| `/newchat`, `/forget` | Clear session (memory persists) |
| `/voice` | Toggle voice responses |
| `/img <description>` | Generate an image |
| `/model` | Switch model (Opus/Sonnet/Haiku) |
| `/schedule <cron> <text>` | Create a scheduled task |
| `/usage` | Token statistics |
| `/stats` | Inline stats on/off |
| `/lang` | Interface language |
| `/admin` | Admin panel |
| `/session` | Browse CLI sessions |
| `/cancel` | Cancel current request |

## Project Structure

```
BotVa/
├── src/                    # Platform code (TypeScript)
│   ├── index.ts            # Entry point
│   ├── bot.ts              # Telegram bot
│   ├── agent.ts            # Claude agent with MCP
│   ├── builtin-tools.ts    # Built-in tools
│   ├── memory.ts           # Memory system
│   ├── db.ts               # SQLite
│   ├── voice.ts            # STT/TTS
│   ├── imagen.ts           # Image generation
│   ├── scheduler.ts        # Scheduler
│   └── admin/              # Web admin panel
├── roles/                  # Role templates
│   ├── _soul.md            # Base character (for all bots)
│   ├── _tools.md           # Base tool routing
│   └── *.md                # Roles (personal-assistant, researcher, ...)
├── mcp-servers/            # MCP servers
│   ├── bitrix24/           # Bitrix24 CRM
│   ├── meta-ads-mcp/       # Meta/Facebook Ads
│   ├── colleague/          # Inter-bot communication
│   ├── manager/            # Manager coordination
│   └── pubmed/             # PubMed search
├── scripts/                # Management scripts
├── installer/              # Web installer
├── bots/                   # Bot data (gitignored)
├── workspace/              # Runtime data (gitignored)
├── .env.example            # Configuration template
└── package.json
```

## Management

```bash
./scripts/deploy.sh setup      # Install dependencies, build
./scripts/deploy.sh start      # Start all bots
./scripts/deploy.sh stop       # Stop
./scripts/deploy.sh restart    # Restart
./scripts/deploy.sh build      # Rebuild TypeScript + MCP
./scripts/deploy.sh status     # Status
./scripts/deploy.sh backup     # Backup
./scripts/deploy.sh restore    # Restore
```

## Deploy

Detailed guide with configuration and all options: [DEPLOY.md](DEPLOY.md)

## Tech Stack

- **Runtime**: Node.js 20+, TypeScript (strict)
- **Telegram**: Grammy
- **AI**: Anthropic Claude Agent SDK
- **Database**: SQLite (built into Node.js)
- **Web**: Hono
- **Voice**: Edge-TTS (synthesis), Groq Whisper (recognition)
- **Images**: Google Gemini
- **Browser**: Stagehand / Playwright
- **Tests**: Vitest 4.x

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## FAQ

**How do I find my chat ID?**
Start the bot and send `/start` or `/chatid`.

**How do I add knowledge to a bot?**
Place .md or .txt files in `bots/<name>/knowledge/`. Also available via admin panel (Knowledge).

**How do I connect an integration?**
Add the required variables to the bot's `.env`. After restart, the bot automatically gets the tools.

**How do I migrate to another server?**
See the "Migration" section in [DEPLOY.md](DEPLOY.md).

## License

MIT
