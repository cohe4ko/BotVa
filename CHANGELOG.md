# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.1] — 2026-04-09

### Added
- **ElevenLabs TTS provider** with direct calls from the BotVa server (no relay). Local JSON key store at `store/elevenlabs-keys.json` with usage/limit tracking and last-error capture per key.
- **Manual key rotation**: multiple ElevenLabs keys can be stored simultaneously, exactly one is marked active and used for synthesis. Rotation is operator-driven via the admin UI (no automatic failover between keys, since ElevenLabs treats every key with the same anti-abuse logic).
- **Top-level `/audio` admin tab** (shared across all bots): keys CRUD with active radio, per-language voice picker for both Edge and ElevenLabs, full provider parameters, model selector, ElevenLabs `speed`/`stability`/`similarity_boost`/`style` sliders with live values, Edge rate input. Responsive grid layout that collapses gracefully on narrow screens.
- **Separate provider strategies** for two distinct TTS use cases: `TTS_PROVIDER_REPLY` for the bot's automatic voice replies and `TTS_PROVIDER_TOOL` for the agent-invoked `TextToSpeech` tool. Each can be independently set to `edge` / `elevenlabs` / `auto`.
- **Sentence-aware text chunking** (`src/tts-providers/chunking.ts`): long texts are split on sentence boundaries (abbreviation-safe — `п.`, `т.д.`, `mr.` etc. don't trigger a split), each chunk fits the provider's safe length, with `MAX_CHUNKS=20` hard cap to prevent voice-message spam. Synthesis returns an array of mp3 paths sent as sequential voice messages.
- **Long-text inline keyboard prompt**: in `auto` mode, when the bot is about to auto-voice a reply longer than 1500 chars, it asks the user via inline keyboard which engine to use (`🎙 ElevenLabs` / `🤖 Edge` / `❌`) — ElevenLabs as silver bullet, used deliberately.
- **`/usage` ElevenLabs block**: shows per-key usage with active marker, used/limit, percent, remaining, and warning indicator if the key has a recorded `last_error`.
- **Curated Edge voice catalog**: per-language picker (Ostap/Polina, Dmitry/Svetlana, Andrew/Brian/Aria/Emma/Ryan/Sonia) instead of hardcoded defaults.
- **`updateRootEnvKeys()` / `updateEnvKeys()` helpers** in `src/admin/env-parser.ts` for in-place updates of specific keys in root and per-bot `.env` files preserving comments and layout.

### Changed
- **`synthesize()` returns `Promise<string[]>`** instead of `Promise<string>` — both `bot.ts` auto-TTS path and `TextToSpeech` tool loop through the array and send each chunk as a separate voice message with a 400 ms delay between them.
- **ElevenLabs `voice_settings` are now explicit**: previously `speed` was omitted, causing the model to use the per-voice default which was often >1.0 and made speech sound rushed. Now defaults to `speed=1.0`, `stability=0.6`, `similarity_boost=0.75`, `style=0`, `use_speaker_boost=true`, all overridable from the admin UI.
- **`src/voice.ts`** is now a thin wrapper around `src/tts-providers/`. Edge code moved to `src/tts-providers/edge.ts`, Edge no longer falls back to `TTS_VOICE_{LANG}` (which is reserved for ElevenLabs voice ids) — uses `TTS_VOICE_EDGE_{LANG}` or hardcoded defaults.

### Fixed
- **Edge TTS receiving an ElevenLabs voice id** as fallback when ElevenLabs failed in `auto` mode, causing `Invalid voice 'FGY2WhTYpPnrIDTdsKH5'` errors. Edge and ElevenLabs voice slots are now fully separated.
- **Audio settings save** now reloads the page so voice pickers re-render with the new selection — previously the user couldn't visually verify what got saved.

### Removed
- **Cloudflare Worker relay** (initial design): direct calls from BotVa server are simpler and free-tier ElevenLabs keys cannot be used through Cloudflare Workers anyway because ElevenLabs detects datacenter egress IPs and blocks `text-to-speech` requests with `detected_unusual_activity` while still allowing `subscription` reads. Removed `src/tts-worker/`, `src/tts-providers/cloudflare-api.ts`, all CF env vars (`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, `TTS_WORKER_*`).

## [1.1.0] — 2026-04-07

### Added
- **Workspace-files refactor**: split into global (`roles/_soul.md`, `roles/_tools.md`) and per-bot layers. Globals are read from `roles/` at runtime — edits propagate to all bots instantly, no on-disk snapshots.
- **`<!-- REPLACES_GLOBAL -->` marker**: per-bot `BOT_SOUL.md`/`BOT_TOOLS.md` can fully replace the corresponding global layer (for authored bots with their own character).
- **Feature flags in `.env`**: `GROUP_CHAT_ENABLED`, `DEV_MODE_ENABLED`, `GIT_ACCESS_ENABLED` — toggle conditional inline blocks `<!-- IF FEATURE -->...<!-- END -->` in `_soul.md`. Content stays in source, injected only into bots that actually use it.
- **`roles/SHARDS.md`**: formal layer contract — what lives where, canonical topic map, 5 content categories, emoji legend.
- **Emoji hierarchy markers**: 🔒 invariant / 💡 recommendation / 🎯 example / ✅ correct / ❌ anti-pattern / 📌 context. Legend defined once in `_soul.md`, then emoji-only across shards.
- **Master tool routing table** in `_tools.md`: a single canonical "user intent → tool" table replaces 8 scattered bullet sections.
- **Drilldown sections with examples** for `CreateReminder`, `SaveFact`, `AskUser`, command execution, and workspace ops: each with 3–7 few-shot examples plus anti-examples.
- **CreateReminder MEMO/AGENT modes**: explicit distinction between one-shot reminders and cron tasks for the bot. Decision tree for choosing between `runAgent=false/true` and `schedule`.
- **Admin lint**: when editing `BOT_SOUL.md`/`BOT_TOOLS.md` the admin computes jaccard similarity against the global layer and shows a warning at ≥80% (yellow) or ≥95% (red).
- **Admin preview**: an "Assembled CLAUDE.md" block on `/bot/<name>/config` shows the final assembled output with exact token count via `@anthropic-ai/tokenizer`.
- **Per-file descriptions** in the workspace editor: italic 1–2 sentence hints describing what should live in IDENTITY / SOUL / BOT_SOUL / ROLE / TOOLS / BOT_TOOLS / USER / MEMORY.
- **Contract test suite** (`src/workspace-files-contract.test.ts`): 8 invariants × bots — no h2 duplicates, tool over-mention, behavioral anchor counts, 🔒 markers, IF/REPLACES_GLOBAL marker stripping, ≤30 KB size.
- **Migration script** `scripts/migrate-workspace-split.ts`: splits legacy per-bot TOOLS into global + BOT_TOOLS via anchor-based prefix extraction, with backup.
- **FTS5 delete/update fix** for facts: resolved "SQL logic error" when deleting facts with the FTS index, plus regression tests.
- **Admin log viewer** finds logs in the centralised `workspace/logs/` directory.
- **Two-button progress keyboard**: Stop (soft) + Interrupt (hard) instead of a single button.
- **Listener STT language** now persists across restarts.

### Changed
- **`_soul.md` consolidation**: 13 KB → 9 KB. Kept only character + values + boundaries + meta-rules + emoji legend. Removed markdown tutorial, workspace-files mechanics, group chat protocol (moved to an IF block), and command execution (moved to `_tools.md`).
- **`_tools.md` consolidation**: removed long-form section duplicates (`## Web Search`, `## Image Generation`, `## File publishing`, `## Browser`, `## Presentations`, `## Available Skills`). Few-shot example density increased.
- **`roles/personal-assistant.md` TOOLS section**: trimmed to 4 truly role-specific lines (Home Assistant, Calendar, Bitrix24, stagehand).
- **Admin `/bot/<name>/config`**: removed the textarea + "Save CLAUDE.md" button (CLAUDE.md is now dynamic). `apply-template` uses `refreshClaudeMd` instead of manual stitching.
- **Heading convention**: renamed adjacent h2s to avoid clashes (`## Memory` → `## Three memory systems`; `## Response format` → `## Response style`; `## Rules` in ROLE → `## Working style`).
- **Telegraph table rendering** fixed — proper column alignment preservation and per-table state isolation.

### Fixed
- Cron tasks now register correctly — the agent understands the `schedule` parameter via the consolidated CreateReminder section with examples. Previously `_tools.md` mentioned only one-shot reminders, causing `CreateReminder(remindAt=...)` instead of `schedule="0 9 * * *"`.
- SOUL section duplicates in the assembled CLAUDE.md (the migration script previously copied wholesale on any divergence).
- Stale `context/memories/YYYY-MM-DD.md` rule in the role template that conflicted with the new CreateReminder section.
- Structural drift: edits to `roles/_tools.md` now propagate to all bots instantly, no on-disk snapshots.

## [1.0.2] — 2026-03-31

### Додано
- Content hash дедуплікація фактів з автоматичним backfill існуючих записів
- Двохрівнева progressive disclosure для memory context (high/low confidence tiers)
- Auto-usefulness tracking: факти які реально використовуються отримують більшу вагу
- Agent catalog: завантаження спеціалістів з `~/.claude/agents/` з keyword matcher для делегування
- Інструкції для бота щодо Agent Specialists у `_tools.md`
- `/usage` показує ліміти Claude акаунту (5h/7d usage)
- CreateReminder підтримує `runAgent` та `schedule` (cron) для повторюваних нагадувань
- Автономна роль бота (`autonomous.md`, `_soul_autonomous.md`)

### Змінено
- Консолідація: DRY правила збереження фактів з GOOD/BAD прикладами (єдина `buildConsolidationRules()`)
- SaveFact gracefully пропускає дублікати (повертає -1) замість помилки

## [1.0.1] — 2026-03-26

### Додано
- Автоматичне оновлення OAuth токена Claude CLI з backoff стратегією (`src/claude-auth.ts`)
- Warning-банер на дашборді адмінки при відсутній автентифікації
- Telegram-нотифікація власнику бота при протуханні токена (i18n: uk/en)
- `/usage` показує статус Claude CLI: email, тип підписки, час до протухання
- Крок логіну в Claude CLI в інструкціях встановлення (README.md, DEPLOY.md)

## [1.0.0] — 2026-03-21

Перший публічний реліз BotVa — мульти-бот Telegram-платформи на базі Claude AI.

### Додано

#### Ядро платформи
- Мульти-бот архітектура з ізольованими конфігами, пам'яттю та workspace файлами
- Інтеграція з Claude Agent SDK (v0.2.x) з підтримкою 200k/1M контексту
- Система ролей: шаблони з маркерами `IDENTITY/ROLE/TOOLS` та динамічна збірка `CLAUDE.md`
- Crash watchdog зі stable-збіркою та автоматичним відкатом
- Graceful restart через flag-файл
- Режими агента: full / ask user / plan

#### Telegram-інтерфейс
- Команди: `/new`, `/session`, `/settings`, `/model`, `/lang`, `/restart`, `/update`, `/stop`, `/pause`, `/resume`
- Підтримка голосових повідомлень з мультимовним STT (uk/ru/en) через Whisper
- Voice confirm — підтвердження транскрипції перед відправкою
- Груповий чат — мульти-бот діалог з @mention, relay-комунікацією та Telegraph для довгих повідомлень
- Контекстна ін'єкція повідомлень під час дебатів
- Підтримка альбомів (медіа-групи 2–10 файлів)
- i18n (EN/UK) з командою `/lang`
- AskUser: кнопки, reply keyboard, Telegram polls

#### Builtin інструменти (30+)
- **Медіа**: GenerateImage, EditImage, TextToSpeech, SendMedia, SendGalleryImage, ListGalleryImages, DeleteGalleryImage
- **Пам'ять**: SaveFact, SearchMemory, DeleteFact з семантичним пошуком через embeddings
- **Комунікація**: SendEmail, ForwardMessage, SetReaction, ShareFile, PublishTelegraph
- **Боти**: CreateBot, DeleteBot, ListBots, AskUser
- **Утиліти**: RunPython, CurrencyRates, GetCurrentTime, TakeScreenshot, NameSession
- **Backup**: CreateBackup, ListBackups, VerifyBackup, RestoreBackup, DeleteBackup
- **Нагадування**: CreateReminder, ListReminders, DeleteReminder
- **AI**: AskGemini, GeminiSearch
- **Workspace**: ReadWorkspaceFile, WriteWorkspaceFile

#### MCP інтеграції
- Bitrix24 CRM (контакти, ліди, угоди)
- Google Workspace (Calendar, Gmail, Drive)
- Home Assistant (розумний дім)
- Meta Ads (Facebook/Instagram реклама)
- Stagehand (AI-браузер)
- PubMed (наукові статті)
- Miro (дошки, HTTP/SSE)
- Playwright Remote (headless Chrome)
- Каталог 40+ MCP серверів

#### Пам'ять та контекст
- Абсолютна пам'ять: факти з тегами, batch save, OR-search
- Семантичний пошук через shared embedding service
- Проактивний пошук фактів + preference sector
- Консолідація сесій v2: single agent call, queue retry, weekly summary
- Workspace файли — живі файли бота між сесіями
- Auto-react через локальні embeddings (zero tokens)
- Disk-based сесії з пагінацією

#### Адмін-панель
- Dashboard: сервіси, статистика, watchdog
- Сторінки ботів: config, facts, sessions, logs, workspace files, gallery
- Діагностика: системна та по-бот з історією
- Шаблони ролей з попереднім переглядом
- Tool usage статистика
- Web-термінал з Claude Code CLI
- Session viewer — перегляд вмісту сесій
- Room Listener: записи, транскрипція, управління пристроями
- Sidebar навігація з hover-expand
- Мобільна адаптація
- CSRF захист, XSS фільтрація, input validation
- i18n (EN/UK), темна тема

#### Деплой та інфраструктура
- `deploy.sh`: build, start, stop, status, logs, backup, restore, systemd
- Автоматична установка Node.js 22 через fnm
- Systemd subcommand для Linux-сервісів
- Web installer для автоматичного provisioning (Render, Railway, Docker)
- Pre-commit hook для сканування секретів

#### Тести
- Vitest 4.x з 80+ тестами по 12 модулях
- Покриття: agent, scheduler, media, email, auto-react, disk-sessions, MCP config

[1.0.0]: https://github.com/cohe4ko/BotVa/releases/tag/v1.0.0
