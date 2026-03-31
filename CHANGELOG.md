# Changelog

Усі значні зміни в проєкті документуються в цьому файлі.

Формат базується на [Keep a Changelog](https://keepachangelog.com/uk/1.1.0/),
проєкт дотримується [Semantic Versioning](https://semver.org/lang/uk/).

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
