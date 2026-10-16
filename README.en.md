# BotVa

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org)

[🇺🇦 Українська](README.md)

A multi-bot Telegram platform built on Claude AI. One server – many bots, each with its own role, memory, knowledge, and integrations.

<p align="center">
  <img src="screenshots/admin-dashboard.jpg" alt="BotVa Dashboard" width="700">
</p>

## What sets BotVa apart

- **Memory as a first-class entity.** Facts are stored in SQLite (topic, tags, access_count) + daily conversation logs + weekly consolidations via Claude. Consolidation runs automatically every night.
- **Team of bots.** Bots communicate through Unix sockets (Colleague MCP), the manager distributes tasks in parallel using `Promise.allSettled()`.
- **Complete isolation.** Each bot is a separate process, with its own `.env` file, database, knowledge, memory, voice, and role. They are managed from a single admin panel.
- **Live management.** Web panel for creating bots, image galleries, cron jobs, backups, diagnostics. The chat model, background model (for service calls), and reasoning effort can be changed without restarting. Changes to `.env` files require a restart through the UI.
- **Dynamic integrations.** MCP servers are connected if the corresponding environment variables are present – add `BITRIX24_WEBHOOK_URL`, restart the bot, and it will receive CRM data. No code changes required.
- **Philosophy.** The basic role (`_soul.md`) is a manifesto: how to think, how to communicate, when to be silent. Not "certainly!", but a human conversation.

## Key Features

<p align="center">
  <img src="screenshots/telegram-demo-result.jpg" alt="Bot in action — parallel tools" width="500">
</p>
<p align="center"><em>Parallel execution: web search, image generation, Python graph, currency rates — all with a single request</em></p>

- **Multiple bots** from a single Node.js instance.
- **14 pre-built roles** -- from personal assistant to autonomous agent.
- **Memory** -- facts with deduplication based on content-hash, FTS5 search, and usefulness tracking, daily diary logs with consolidation.
- **Workspace files** -- 8-layer structure of CLAUDE.md (GLOBAL SOUL/TOOLS, BOT_SOUL/BOT_TOOLS/IDENTITY/ROLE/USER/MEMORY per-bot) with feature-flag blocks.
- **Voice** -- voice messages and responses (Groq STT + Gemini TTS / Edge TTS / ElevenLabs with key rotation).
- **Images** -- generation and editing via Gemini with an auto-gallery.
- **Gemini AI** -- second opinion (AskGemini) and search with citations (GeminiSearch).
- **Bot team** -- communication via Unix sockets, task delegation, directory of specialist agents with keyword matcher.
- **Scheduler** -- cron jobs and reminders with `runAgent` mode (execute as a full request with tools).
- **Utilities** -- currency rates, time, Python sandbox, email, Telegraph.
- **Integrations** -- Google Workspace, smart home, any MCP servers.
- **Web search** -- search, scraping, AI browser (Stagehand).
- **Admin panel** -- full web interface for management.
- **Audio recorder** -- background recording from microphone (Orange Pi / Mac), VAD silence filter, Whisper transcription.
- **Backups** -- full and per-bot, with SHA256 verification.

## Quick Start

### Installation on VPS (fastest way)

Go to **https://botva-installer.onrender.com/**, enter the server IP address and Telegram token -- and in 3-5 minutes the bot will be running. More details: [DEPLOY.md](DEPLOY.md)

### Local Installation

```bash
# 1. Clone
git clone https://github.com/cohe4ko/BotVa.git BotVa
cd BotVa

# 2. Install dependencies and build
./scripts/deploy.sh setup

# 3. Create the first bot (Option A: CLI)
npm run new-bot -- my-bot personal-assistant --emoji 🧑‍💼 --name "My Bot"

# 3. Create the first bot (Option B: Web Interface)
./scripts/deploy.sh admin  # Start the admin panel
#    Open http://localhost:3000 → Create Bot
#    The token and chat ID are entered in the bot creation form.

# 4. Configure tokens (if using CLI)
#    Open bots/my-bot/.env:
#    - TELEGRAM_BOT_TOKEN (obtain from @BotFather in Telegram)
#    - ALLOWED_CHAT_ID (send the /chatid command to the bot after starting it)

# 5. Log in to the Claude CLI
#    Start the admin panel → Terminal (/terminal)
#    and log in through your subscription (not an API key).

# 6. Start
./scripts/deploy.sh start
```

After starting, send a message to the bot in Telegram -- it will respond.

<details>
<summary>Creating a bot through the web interface</summary>

<img src="screenshots/admin-create-bot.jpg" alt="Creating a bot" width="700">

Choose a role, enter the Telegram token from @BotFather, and the chat ID. API keys can be added later.

<img src="screenshots/admin-bot-created.jpg" alt="Bot created" width="700">

After creation, you will see the file structure and the next steps.
</details>

## Bot Roles

When creating a bot, you choose a role -- it defines the specialization, tools, and style.

| Role | Slug | Description |
|------|------|------|
| Personal Assistant | `personal-assistant` | Everyday tasks, scheduling, CRM, smart home |
| Researcher | `researcher` | In-depth analysis, fact verification, reports |
| Health Advisor | `health-advisor` | Monitoring metrics, analysis, recommendations |
| Academic | `academic` | Scientific articles, methodology, PhD, teaching |
| Creative | `creative` | Design, images, presentations, copywriting |
| Sales | `sales` | Leads, deals, sales analysis, proposals |
| Planner | `planner` | Tasks, deadlines, prioritization |
| Knowledge Base | `knowledge-base` | Documentation, FAQ, knowledge search |
| Manager | `manager` | Coordinating a team of bots, delegation |
| Product/Market | `product-market` | CRM analytics, positioning, competitors |
| Webmaster | `webmaster` | Website, content, deployment, SEO |
| Debate Researcher | `debate-researcher` | Analysis from opposing viewpoints |
| Autonomous Agent | `autonomous` | Long-term tasks without user interaction, own `_soul_autonomous.md` |
| Dome Engineer | `dome-engineer` | Engineering tasks, diagnostics, orchestration of technical workflows |

```bash
npm run new-bot -- <slug> <role> [--emoji 🤖] [--name "Name"]
```

## Features

### Telegram

The first interaction with a bot includes a greeting, profile setup, reminders, and search with clarifying questions:

<p align="center">
  <img src="screenshots/telegram-start.jpg" alt="First interaction" width="400">
  <img src="screenshots/telegram-askuser.jpg" alt="AskUser - clarifying questions" width="400">
</p>

Messages sent while the bot is running do not interrupt it: the model receives them at the next step and takes them into account, without repeating actions. A long command or subagent can be sent to the background using the "⏩ To background" button on the progress message – the bot will immediately switch to a new message, and when the task is complete, it will automatically send the result. A background task lives for `BACKGROUND_TASK_MAX_MS` (default: 30 minutes) after the last response.

### Voice

The bot understands voice messages and can respond with voice. Speech-to-Text (STT) is provided by Groq Whisper (requires `GROQ_API_KEY`). The `TranscribeAudio` tool allows the bot to transcribe local files. If a file is larger than 24 MB or in an unsupported format, ffmpeg automatically converts it to 16 kHz mono FLAC and splits it into 25-minute chunks; the transcripts are then concatenated. There are three Text-to-Speech (TTS) providers: Gemini TTS (free, default - expressive multilingual voices via `GOOGLE_API_KEY`, style controlled by the prompt, fallback to Edge on error/quota), Edge-TTS (free, no limits), and ElevenLabs (higher quality, local JSON store of keys with manual rotation, limit/error tracking, fallback to Gemini/Edge when the quota is exhausted). Providers are configured separately for auto-responses (`TTS_PROVIDER_REPLY`) and tool synthesis (`TTS_PROVIDER_TOOL`). The agent automatically marks the emotional tone of the speech: a `[[tone: ...]]` marker at the end of the response (which is removed from the text) or the `tone` parameter of the TextToSpeech tool – Gemini TTS conveys the emotion through the voice. Sentence-aware chunking of long texts (up to 20 segments) with the sending of sequential voice messages. Voices, speed, stability/similarity are controlled through the `/audio` tab in the admin panel. The `/voice` command toggles voice responses on/off, and the `/usage` command shows the status of the ElevenLabs keys.

### Images

Image generation and editing via Gemini (`GOOGLE_API_KEY`). Use the `/img description` command or simply request it in the chat. All images are saved in the gallery.

### Memory

Three-level system: facts (persistent storage with topic and tags), daily markdown logs, and workspace files (USER.md, MEMORY.md). Consolidation occurs at `NIGHT_OWL_HOUR`.

<p align="center">
  <img src="screenshots/telegram-memory.jpg" alt="Saving facts to memory" width="400">
  <img src="screenshots/telegram-user-profile.jpg" alt="User profile via AskUser" width="400">
</p>
<p align="center"><em>Left: Saving facts using SaveFact/SearchMemory. Right: Filling out a profile using AskUser</em></p>

### Scheduler

Cron jobs: `/schedule 0 9 * * * What do I have on today?`. Standard 5-field cron.

### Bot team

The manager coordinates the work, and bots communicate through Colleague MCP (Unix sockets). Each bot can access the manager through `ask_manager()`.

A new bot can be created without @BotFather: CreateBot without a token sends a button that opens a bot creation window in Telegram. After confirmation, the bot receives a token, and access to it remains only with the owner. You need to enable bot management for the bot creator in the @BotFather Mini App once. RotateBotToken replaces the token of such a bot if the old one is leaked.

### Other people's bots (TGAP)

The bot can directly ask another user's bot (`AskExternalBot`): "ask @petro_bot when Petro is available." The other bot prepares a draft with read-only tools, shows it to the owner with "Send / Edit / Reject / Block" buttons, and only responds after confirmation. The response clearly indicates whether it was confirmed by the owner. Unknown bots, hop limits, rate limits and loop protection are handled according to the [TGAP](docs/tgap-spec.md) protocol. `ManageExternalBots` is a list of bots and their trust levels.

Enable `TGAP_ENABLED=1` in the bot's `.env` file; both bots require Bot-to-Bot Communication Mode in @BotFather. `TGAP_OWNER_NAME` is the name in the bot's "business card" (empty means anonymous), `TGAP_ACCEPT_FROM=known_only` rejects requests from unknown bots, and `TGAP_DRAFT_TOOLS` are additional read-only MCP tools for the draft (`mcp__<server>__<tool>`, comma-separated).

### Telegram

Session mode in `/settings`: **Name** (one conversation, the bot names it using NameSession) or **Topics** - each private chat topic is a separate conversation with its own session (topics are enabled for the bot in @BotFather).

`SendMedia` (photos, documents, albums), `SendChecklist` (list of tasks/shopping list with checkboxes), `ForwardMessage`, `SetReaction` (emoji reaction + removing reaction), `PinMessage`, `OpenWebApp` (Mini App), `AskUser` (buttons, poll with images in options).

### Utilities

`CurrencyRates` (cash exchange rates), `GetCurrentTime`, `RunPython` (isolated: no network or keys, writes only to its own directory, user files are read-only), `SendEmail` (SMTP), `PublishTelegraph`, `ShareFile` (file, folder, or `.zip`/`.tar.gz` -- a multi-file page is deployed on the server in a separate directory with `index.html`).

### Workspace Files

The bot reads and updates its files between sessions: `USER.md` (profile), `MEMORY.md` (memory) using `ReadWorkspaceFile` / `WriteWorkspaceFile`.

Detailed guide: [MANUAL.md](MANUAL.md)

## Integrations

Any [MCP server](https://modelcontextprotocol.io) can be connected via `mcp-servers.json`.

**Built-in (included):**

| Integration | MCP Server | Required Variables |
|------------|-----------|-----------------|
| Playwright (headless Chrome) | `playwright-remote` | -- |
| Stagehand (AI browser) | `stagehand` | `GOOGLE_API_KEY` |
| Google Calendar, Gmail, Drive | `google-workspace` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| Home Assistant | `home-assistant` | `HA_URL`, `HA_TOKEN` |
| Telegram Observer (personal account) | `telegram` | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` |

Other MCP servers (CRM, advertising, scientific databases, etc.) are added as an entry in `mcp-servers.json` and enabled in the admin panel under System → MCP Servers.

A server can have prerequisites. `envVars` are the required environment variables; `requiresFile` are the files that must exist (paths from the project root). The latter is needed where the server is not started by configuration, but by an action: `telegram` only provides tools after the account is actually connected, because that's when `store/telegram.session` appears. The file survives disconnections and daemon restarts, so the tools do not disappear during unavailability – they simply do not appear until something is connected.

## Audio Recorder (Listener)

A background system for recording audio from microphones, automatic transcription (Groq Whisper), and analysis using Claude.

**Components:**

| Component | Description | Location |
|-----------|------|-------------|
| Receiver | HTTP server, receives WAV files, transcribes them, and analyzes them | `scripts/orange-pi-listener/receive-transcript.ts` |
| Orange Pi Listener | Python daemon for SBC with a microphone | `scripts/orange-pi-listener/listener.py` |
| Mac Listener | Electron tray app for macOS | `scripts/mac-listener/` |

**How it works:**

1. The device records audio in chunks (default 5 minutes).
2. Voice Activity Detection (VAD) filters out silence – chunks with less than 15% speech are skipped.
3. Chunks with speech are sent to the Receiver (`POST /audio`, multipart WAV).
4. The Receiver transcribes the audio using Groq Whisper and stores daily summaries.

**Mac Listener (tray app):**

```bash
cd scripts/mac-listener && npm install && npm start
```

Env: `UPLOAD_URL=http://host:3847/audio`, `DEVICE_ID=mac-1`. Two modes: Toggle (manual start/stop) and Continuous (automatic chunks). Requires `ffmpeg`.

**Receiver:**

```bash
npx tsx scripts/orange-pi-listener/receive-transcript.ts
```

Env: `GROQ_API_KEY` (or `GROQ_API_KEYS`), `LISTENER_PORT=3847`, `ANTHROPIC_API_KEY` (for analysis).

Devices are displayed in the admin panel under System → Recorder.

## Telegram Observer

A daemon that maintains an MTProto session for the **owner's personal account** (not a bot), logs conversations, and provides bots with tools to act on behalf of the owner.

**Components:**

| Component | Description | Location |
|-----------|------|-------------|
| Daemon | GramJS client, logger, MCP server | `src/telegram/daemon.ts` |
| MCP-shim | Pipes stdio ↔ Unix socket | `mcp-servers/telegram/` |
| Management | start / stop / restart / status / install / uninstall | `scripts/telegram-observer.sh` |
| Admin Panel | Connections, chats, log | **Telegram** section |

**Configuration:**

1. Obtain `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from [my.telegram.org](https://my.telegram.org) → API development tools, and add them to the `.env` file.
2. Admin panel → Telegram → enter phone number → code from Telegram → 2FA password (if applicable).
3. Start the daemon using the button in the admin panel or by running `scripts/telegram-observer.sh start`.
4. Enable the `telegram` server in `mcp-servers.json` (System → MCP Servers). Tools will appear for the bots only after successful login; before that, the server is listed with the condition "Telegram connected".
5. `scripts/telegram-observer.sh install` — installs as a launchd service with automatic restart after failure (also done by `deploy.sh launchd`).

**Network Disconnection Resilience:**

| Mechanism | What it does |
|----------|-----------|
| Infinite reconnect | GramJS attempts to reconnect without limiting the number of attempts — any disconnection duration will not terminate the daemon. |
| Watchdog | Every 5 minutes, it checks the update counter; if it's stuck, it verifies the connection with a real request, then reconnects, and exits with code 1 after two failures. |
| launchd `KeepAlive` | Restarts the daemon after a crash or watchdog exit; a normal `stop` (exit code 0) will leave it stopped. |

**Chat Modes** — configured in the admin panel; the default depends on the type:

| Mode | Logging | Fact Extraction | Default for |
|-------|-----|--------------|-----------|
| `ignore` | no | no | bots, supergroups, channels |
| `log-only` | yes | no | private chats, basic groups |
| `facts-only` | yes | facts | — |
| `full` | yes | facts + tasks | — |

Chats with bots are always `ignore` by default to prevent the daemon from reading responses from its own BotVa bots.

**MCP Tools for Bots:**

| Tool | Description | Gate |
|------|-----------|------|
| `tg_list_chats` | List chats (from log or live) | — |
| `tg_unread` | Chats with unread messages | — |
| `tg_read_chat` | Last messages in a chat | — |
| `tg_search` | Search the chat history archive | — |
| `tg_resolve` | Find `chat_id` by @username or name | — |
| `tg_send_message` | Send a message | allowlist + limit of 10/hour, 30/day |
| `tg_send_file` | Send a file or photo | allowlist + limit |
| `tg_mark_read` | Mark a chat as read | — |
| `tg_chat_state` | Live chat status: unread, last read by the owner | — |
| `tg_my_messages` | Only the owner's messages in the chat (filtered on the Telegram side) | — |
| `tg_seed_chat` | Populate the local chat archive: fresh history + owner's messages | — |
| `tg_chat_members` | Group composition - actual members, not just those who wrote | — |
| `tg_people` | People directory: canonical name, role, activity | — |
| `tg_name_person` | Record who this person is: name, role, aliases, note | — |
| `tg_contact_note` | Telegram profile: note, whether in contacts, path to avatar | — |
| `tg_write_note` | Write a note to a contact profile (visible from phone and desktop) | only for those in contacts |
| `tg_add_contact` | Add a person to the owner's contacts by peer/@nickname, with name and note | number is not revealed without `share_phone` |
| `tg_import_contact` | Add a contact **by phone number** - a full contact, suitable for a card | the number is uploaded to Telegram for searching for matches |
| `tg_send_contact` | Send someone another person's contact - as a card or `.vcf` file | allowlist + limit; card requires a visible number |

Sending is allowed only to chats with the "Sending" flag enabled in the admin panel; each action is logged. The bot should show a draft and obtain confirmation via `AskUser` before calling `tg_send_*`.

**Read receipts.** Reading (`tg_read_chat`, `tg_search`, log) does not change the read state—the observation is invisible to the conversation partner. However, `tg_send_*` marks the chat as read before sending: otherwise, the conversation partner sees the reply while their own messages are still marked as unread, which looks unnatural. This can be disabled with the `mark_read: false` parameter.

**People.** The `tg_people` directory is automatically populated from the log—each incoming message updates the name, @username, counter, and last contact date, without making any unnecessary requests to Telegram. In addition, you can manually specify a **canonical name** (which overrides the name the person uses on Telegram), a **role** (e.g., wife, contractor, client), aliases, and a note in the admin panel or by the bot using `tg_name_person`. The role is what makes a fact meaningful: "I'll be there on Thursday" from a wife and from a contractor means different things.

**Scheduled tasks.** An agent launched via cron or a reminder with `runAgent` receives Telegram—but **without tools that write to other people**: `tg_send_message`, `tg_send_file`, `tg_send_contact` are not only rejected but also do not appear in the model's context (`disallowedTools`). Reading, notes, and contacts remain available: they exist within the owner's account and are reversible, while messages sent on their behalf at 3 AM are not. The list of "what can be sent" is in `src/telegram/tool-names.ts`, and the test will fail if a new `tg_send_*` is added without being included there. `AskUser` is intentionally not available in scheduled tasks: there is no one to ask, and asking a question into an empty room results in a hung task.

**Request Accounting.** Every call to Telegram follows a common pattern: one request at a time, with a base of 700ms plus up to 500ms of jitter, a daily limit of 3000 requests, and a global pause for the entire `FLOOD_WAIT` duration. The counter is stored in `tg_api_calls`, **keyed by date and call identifier**, rather than in process memory. This prevents a process restart from resetting the limit, and avoids a situation where a loop continuously makes requests and bypasses the limit. The identifier is needed so that when there's a spike in usage, you can determine "what exactly caused it": in the health status line, next to the total, are the largest consumers (`catchUp.getMessages 26, users.getFullUser 3`). The watchdog probe is counted separately; it doesn't have rate limiting or budget restrictions because a rejection would be interpreted as a dead connection, and the watchdog would restart itself based on the number in the counter.

**Avatars.** `tg_contact_note` returns the **file path**, not the image itself: the avatar is stored in `workspace/telegram/media/avatars/<peer_id>_<photo_id>.jpg` and is downloaded only once. The filename includes the ID of the photo itself, so a changed avatar is a different file, and an unchanged avatar is never downloaded again.

**Two notes.** `tg_people.note` – our note, stored in `store/telegram.db`, which is only visible to the system. A note within the contact profile itself (`tg_contact_note` / `tg_write_note`) is a Telegram note, the one that appears in the client and is marked as "only visible to you": it appears next to the person on the owner's phone and desktop, i.e., at the moment when they are interacting with that person. `tg_write_note` defaults to writing to both. The note lives on the **contact**. For a person who is not a contact, Telegram has nowhere to store it, so first `tg_add_contact` is used. Along with the contact card, the note is **not transmitted**: there is no such field in `inputMediaContact`, it remains in the owner's account. `tg_send_contact` sends the card on behalf of the owner and has a separate parameter `comment` – a signature below the card, which the **recipient will see**. A private note is never inserted there: that's the point of the separate parameter.

**Two ways to add a contact.** `tg_add_contact` takes a peer or a @nickname – it's fast, but the contact is created **without a phone number**, and you can't send it a card afterwards. `tg_import_contact` takes a phone number and goes through `contacts.importContacts`, like synchronizing the phone's address book: this is the only way to create a contact that Telegram considers complete. The phone number is uploaded to Telegram to search for a match; if there is no account with that number, nothing will be found, and nothing will be sent to anyone. `tg_add_contact` also accepts `phone` if the number is known in advance.

**A contact card only exists with a phone number.** `inputMediaContact` is associated with a phone number, and if the owner's number is not visible – which is always the case when a person is added to contacts one-way, without exchanging numbers – Telegram returns `MEDIA_EMPTY`. A non-empty vCard doesn't fix this (verified with a real send: error occurs). Therefore, `tg_send_contact` immediately rejects the request, mentioning the person's name and @nickname, and suggests two working alternatives.

**The `.vcf` file (`as_file: true`)** is a workaround for this limitation: the phone number requirement applies specifically to the `inputMediaContact` media, and the document itself doesn't have it. The nickname is written in the file in four ways because address books don't agree on where the messenger profile resides: `item1.IMPP;X-SERVICE-TYPE=Telegram;type=pref:x-apple:<nickname>` with the `X-ABLabel` tag (which is what Apple Contacts writes when exporting – rendered as a Telegram string), `X-SOCIALPROFILE` (read by Apple and Google), a formatted `URL:https://t.me/<nickname>`, and the same as plain text in the `NOTE` field. Also, `X-TELEGRAM-ID` is included – not for contact purposes, but as an identifier that will survive a nickname change. The recipient imports the file into their phone contacts with a single tap. Verified with a real send to a person without a visible number. The second option is simply sending the information as text via `tg_send_message`.

By default, the contact card is sent with an empty vCard – just like when sharing a contact directly from Telegram. The `attach_note` flag includes the **same** `comment` inside the contact card (`NOTE:` in the vCard): no client displays it, but the server stores it (verified with a real send) and it ends up in the address book when the recipient saves the contact on their phone. This means the signature is read once and disappears from the feed, while the embedded one remains with the person. It's the `comment` that's included, and not some other text – to ensure that nothing invisible is sent to the recipient. Without the `comment`, the flag results in an error, not a silent no-op.

The composition of a group is separate from who was writing in it: a silent participant is not visible in the log, and someone who left remains in it forever. `tg_chat_members` with `refresh=true` fetches the group composition from Telegram (a basic group - one request, a supergroup - in pages of 200) and honestly reports how many are visible, because Telegram does not provide information about all members to non-administrators.

**Fact Extraction (Tier 1).** For chats in `facts-only` or `full` mode, where a receiving bot is assigned in the "Analysis" column. The conversation accumulates in a buffer and is processed when the first of the following occurs: 4 minutes of silence, 25 messages, 30 minutes from the first message; there must be at least one minute between two processing cycles of the same chat.

| What is extracted | Where |
|---|---|
| `facts`, `contacts` | fact, sector `semantic` |
| `events` | fact, sector `episodic` |
| `commitments_mine` - the owner promised | fact + reminder |
| `commitments_theirs` - the owner was promised | fact + reminder |
| `requests` - the owner was asked | fact + reminder |
| `dates` - a meeting or deadline in itself | fact + reminder |

An incoming "do it by Friday" and an outgoing "I will do it by Friday" are different things with opposite consequences, and the prompt clearly distinguishes between them. Each item must include a verbatim quote and `msg_ids`: without them, the fact cannot be verified or removed when the source is edited.

| Confidence | What is done |
|---|---|
| ≥ 0.75 | written to memory immediately; a task with a date creates a reminder |
| 0.45–0.75 | added to the revision queue in the admin panel |
| < 0.45 | remains only in the log |

Tasks without a due date are never automatically scheduled as reminders; instead, they are placed in a queue where a due date can be manually entered. Before a fact is recorded, it is compared to existing facts in the bot using embeddings. A match of over 0.9 does not create a duplicate but increases the usefulness score of the existing fact. Editing or deleting a message marks dependent items as `stale`—it does not silently delete them. Limit: 200 processing requests per day and 40 per hour; after reaching the limit, logging continues, but analysis is delayed until midnight.

**Missed messages during downtime.** MTProto only provides updates to a live connection, so restarting the daemon would leave a gap in the log. Upon startup, the daemon retrieves missed messages using `messages.getHistory`: from the saved cursor (the last acknowledged `msg_id` in the chat), and for chats seen for the first time, the last 20 messages. No backlog: chats in `ignore` mode are skipped, there is a pause between chats, and `FLOOD_WAIT` is handled with a delay.

**Account-based isolation.** Each entry is associated with the owner of the MTProto session. The `direction` (incoming/outgoing) is only meaningful relative to a specific account, and the same `chat_id` under a different login means the opposite. Data from previous accounts remains in the database but is not displayed, searched, or counted; the admin panel shows the number of such entries and offers to delete them.

**Auto-response in a chat.** A chat can be associated with a specific bot: if an incoming message remains unanswered for longer than the threshold, the bot responds on behalf of the owner based on the conversation context.

| Parameter | Location | Default |
|---|---|---|
| Auto-responder bot | Telegram → Chats → "Auto-response" column | disabled |
| Silence threshold | same | 5 minutes (from 30 seconds to 3 hours) |
| "Only unread" | same | enabled |
| "Only mentions" | same | enabled for groups, disabled for private chats |
| Prompt | Telegram → chat → "Auto-response prompt" | empty |

**Session and Style.** A single agent session runs within a Telegram chat (`tg:<chat_id>`). At the start of a session, there's a priming phase: up to 200 messages from the chat history (150 for groups, plus a separate block of 50 of the owner's messages within that history) are provided, along with instructions on how the owner writes in that specific chat. Long messages from the owner are truncated, not discarded. Subsequently, each turn includes everything that has happened since the last time the session processed the chat, including messages the owner themselves wrote. If the gap is larger than 120 messages, the prompt explicitly states how many messages are missing.

**Via Telegram Business.** When a bot is connected to the owner's account (Settings → Chat Automation, without Premium) and allowed to respond, auto-replies in private chats covered by Chat Automation are sent through the official Telegram API using `sendMessage` with a `business_connection_id`, rather than through the userbot session. The autoresponder, based on the observer's log, still determines when and how to respond; only the transport mechanism changes. Groups, proactive messages, and responses outside the 24-hour window remain handled by the observer. The chat must be associated with the specific bot connected in Chat Automation; connections are only accepted from the owner (`ALLOWED_CHAT_ID`). The bot requires Secretary Mode in @BotFather.

**Groups.** Before the initial priming of a group with an autoresponder, the archive is populated: the 100 most recent messages plus up to 50 messages from the owner (`tg_seed_chat`, two requests, once per chat). The trigger is only when the owner is mentioned: either by their `@username` in the text or by replying to their message. The silence countdown starts from the last message from the person who triggered the response, so other participants who continue the conversation don't block the response indefinitely.

**Rhythm and Limits.** Model-less checks use direct SQLite reads; the interval follows the shortest threshold (30 seconds → tick of 10 seconds, maximum one minute). The model is only launched when all conditions are met. One response per message; the pause between responses equals the threshold; a live `read-state` query is sent to Telegram before each send (if the owner has opened the chat, the bot remains silent), with a background process to avoid excessive API calls. The bot may refuse to respond, in which case the owner receives a notification in the chat with that bot, and the event is logged with the status "silenced." Sending requires the "Send" checkbox to be enabled and is counted towards the overall limit.

Transport: Unix socket `store/telegram.sock` (permissions 600), not a TCP port. Session: `store/telegram.session` (permissions 600, in .gitignore); access can be revoked in Telegram → Settings → Devices.

**MTProto Layer.** GramJS uses layer 198 and is not updated after February 2025, so fields added to Telegram after that are unavailable. The GramJS classes are built from a TL schema, which is a string located in `tl/apiTl.js` – therefore, `scripts/patch-gramjs.mjs` (postinstall) replaces it with schema 222 from `vendor/telegram-api-222.tl` and updates the `LAYER` constant. This patch is self-canceling: once the upstream releases 222 or newer, the script does nothing.

Plan for future phases (extracting facts and tasks into the bot's memory): [docs/telegram-observer.md](docs/telegram-observer.md)

## Admin Panel

<img src="screenshots/admin-dashboard-5bots.jpg" alt="Dashboard — 5 bots" width="700">

A web interface for managing bots. Two ways to launch:

```bash
# 1. From Telegram (on-demand, auto-stop after 20 minutes)
/admin

# 2. As a separate service (persistent)
./scripts/deploy.sh admin
```

A machine behind NAT, a firewall, or with a dynamic IP: The "🌐 Access from outside" button under `/admin` creates a temporary tunnel and provides an HTTPS link that can be accessed from anywhere. No configuration is required: Cloudflare Quick Tunnel, if `cloudflared` is installed, otherwise localhost.run via the system `ssh`. The tunnel is opened only on request and closed along with the admin panel; access, like locally, is via a one-time token in the link (TLS is terminated on the tunnel provider's side).

| Section | What it does |
|--------|-----------|
| Dashboard | Bot status, requests, costs, services |
| Config | Chat model, background model, reasoning effort, environment variables, workspace files (8 layers) |
| Knowledge | Bot knowledge files |
| Facts | Memory: view, search, edit, FTS5 search |
| Tasks | Reminders and cron jobs with full editing (text, schedule, runAgent) |
| Settings | Chat settings, sessions |
| Usage | Token and cost analytics |
| Audio | TTS providers (Gemini / Edge / ElevenLabs), voice selection, Gemini style, speed/quality parameters, ElevenLabs keys with counters |
| System | Built-in tools, MCP servers, skills on/off |
| Images | Gallery of generated images |
| Logs | Event audit |
| Diagnostics | AI system diagnostics |
| Backup | Creating and restoring backups |
| Team | Bot team management |
| Templates | Role templates |
| Terminal | Browser shell |
| Telegram | Telegram Observer: connecting an account, daemon status, chats with modes and a bot receiver, a directory of people, a queue for reviewing extracted data, logs of incoming/outgoing messages, bot output actions |
| Create Bot | New bot creation wizard |

Detailed guide: [MANUAL.md](MANUAL.md)

## Telegram commands

<p align="center">
  <img src="screenshots/telegram-commands.jpg" alt="Telegram commands" width="400">
  <img src="screenshots/telegram-settings.jpg" alt="Bot settings" width="400">
</p>
<p align="center"><em>Commands /usage, /model, /facts, /settings — managing the bot from Telegram</em></p>

| Command | Description |
|---------|------|
| `/start` | Greeting and chat ID |
| `/chatid` | Show chat ID |
| `/newchat`, `/forget` | Clear the session (memory remains) |
| `/undo` | Undo the last step — the next message will continue from the previous point |
| `/fork` | Branch the conversation: continue in a new branch with the same context, the current one remains in `/session` |
| `/tasks` | Background tasks for this conversation with a stop button for each |
| `/voice` | Enable/disable voice responses |
| `/img <description>` | Generate an image |
| `/model` | Switch the chat model and reasoning effort |
| `/schedule <cron> <text>` | Create a task |
| `/usage` | Token statistics, Claude login status, subscription limits, and ElevenLabs keys |
| `/stats` | Inline on/off statistics |
| `/lang` | Interface language |
| `/admin` | Admin panel |
| `/session` | View CLI sessions |
| `/cancel` | Cancel the request |

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
│   ├── _soul.md            # Base personality (for all bots)
│   ├── _tools.md           # Base tool routing
│   └── *.md                # Roles (personal-assistant, researcher, ...)
├── mcp-servers/            # MCP servers
│   ├── colleague/          # Inter-bot communication
│   └── manager/            # Manager coordination
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

## Deployment

Detailed guide on configuration and all options: [DEPLOY.md](DEPLOY.md)

## Technology Stack

- **Runtime**: Node.js 20+, TypeScript (strict)
- **Telegram**: grammY, GramJS (MTProto)
- **AI**: Anthropic Claude Agent SDK
- **Database**: SQLite (embedded in Node.js)
- **Web**: Hono
- **Voice**: Gemini TTS / Edge-TTS / ElevenLabs (synthesis), Groq Whisper (speech recognition)
- **Images**: Google Gemini
- **Browser**: Stagehand / Playwright
- **Tests**: Vitest 4.x

## How to Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md).

## FAQ

**How do I find my chat ID?**
Start the bot and send `/start` or `/chatid`.

**How do I add knowledge to the bot?**
Place .md or .txt files in `bots/<name>/knowledge/`. You can also do this through the admin panel (Knowledge).

**How do I connect an integration?**
Add the corresponding variables in the bot's `.env` file. After restarting, the bot will automatically obtain the tools.

**How do I migrate to another server?**
See the "Migration" section in [DEPLOY.md](DEPLOY.md).

## License

MIT
