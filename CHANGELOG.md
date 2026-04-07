# Changelog

Усі значні зміни в проєкті документуються в цьому файлі.

Формат базується на [Keep a Changelog](https://keepachangelog.com/uk/1.1.0/),
проєкт дотримується [Semantic Versioning](https://semver.org/lang/uk/).

## [1.1.0] — 2026-04-07

### Додано
- **Workspace-files рефакторинг**: розділення на global (`roles/_soul.md`, `roles/_tools.md`) та per-bot шари. Глобальні файли читаються з `roles/` на льоту — правка миттєво долітає до всіх ботів, жодних snapshot'ів на диску.
- **`<!-- REPLACES_GLOBAL -->` marker**: per-bot `BOT_SOUL.md`/`BOT_TOOLS.md` може повністю замінити відповідний global шар (для авторських ботів з власним характером).
- **Feature flags у `.env`**: `GROUP_CHAT_ENABLED`, `DEV_MODE_ENABLED`, `GIT_ACCESS_ENABLED` — вмикають conditional inline блоки `<!-- IF FEATURE -->...<!-- END -->` в `_soul.md`. Контент є, але інжектиться лише тим ботам, які його реально використовують.
- **`roles/SHARDS.md`**: формальний контракт шарів — що в якому живе, канонічна мапа топіків, 5 категорій контенту, emoji legend.
- **Emoji hierarchy markers**: 🔒 інваріант / 💡 рекомендація / 🎯 приклад / ✅ правильно / ❌ анти-патерн / 📌 контекст. Legend один раз у `_soul.md`, далі лише emoji.
- **Master tool routing table** у `_tools.md`: одна канонічна таблиця "user intent → tool" заміняє 8 розкиданих bullet-секцій.
- **Drilldown секції з прикладами** для `CreateReminder`, `SaveFact`, `AskUser`, `Команда`, `Workspace`: кожна з 3-7 few-shot прикладів + anti-приклади.
- **CreateReminder MEMO/AGENT режими**: явне розрізнення одноразових нагадок і cron-завдань боту. Decision tree для вибору між `runAgent=false/true` та `schedule`.
- **Admin lint**: при редагуванні `BOT_SOUL.md`/`BOT_TOOLS.md` адмінка рахує jaccard similarity з global шаром і показує warning ≥80% (жовтий) або ≥95% (червоний).
- **Admin preview**: блок "Assembled CLAUDE.md" у `/bot/<name>/config` показує фінальний результат збірки з точною кількістю токенів через `@anthropic-ai/tokenizer`.
- **Опис кожного workspace-файлу** у адмінці: курсивна 1-2-реченна підказка що має бути в IDENTITY / SOUL / BOT_SOUL / ROLE / TOOLS / BOT_TOOLS / USER / MEMORY.
- **Contract test suite** (`src/workspace-files-contract.test.ts`): 8 інваріантів × боти — відсутність дублів h2, tool over-mention, behavioral anchors count, 🔒 markers, очищення IF/REPLACES_GLOBAL маркерів, розмір ≤30 KB.
- **Migration script** `scripts/migrate-workspace-split.ts`: розбиває старі per-bot TOOLS на global + BOT_TOOLS через anchor-based prefix extraction, з бекапом.
- **FTS5 delete/update fix** для фактів: виправлено "SQL logic error" при видаленні фактів з FTS індексом + регресійні тести.
- **Admin log viewer** знаходить логи в централізованій `workspace/logs/` директорії.
- **Two-button progress keyboard**: Stop (soft) + Interrupt (hard) замість одної кнопки.
- **Listener STT language** тепер зберігається між рестартами.

### Змінено
- **Консолідація `_soul.md`**: 13 KB → 9 KB. Лишилось лише character + values + boundaries + meta-rules + emoji legend. Викинуто markdown tutorial, workspace-files mechanics, group chat protocol (в IF блок), команда (в `_tools.md`).
- **Консолідація `_tools.md`**: усунено дублі longform секцій (`## Web Search`, `## Image Generation`, `## Публікація файлів`, `## Браузер`, `## Презентації`, `## Available Skills`). Щільність few-shot прикладів зросла.
- **`roles/personal-assistant.md` TOOLS секція**: скорочено до 4 справді role-specific рядків (Home Assistant, Calendar, Bitrix24, stagehand).
- **Адмін-панель `/bot/<name>/config`**: видалено textarea + кнопку "Save CLAUDE.md" (CLAUDE.md тепер динамічний). `apply-template` використовує `refreshClaudeMd` замість ручного склеювання.
- **Heading convention**: перейменовано близькі h2 щоб уникнути клешів (`## Пам'ять` → `## Три системи пам'яті`; `## Формат відповідей` → `## Стиль відповідей`; `## Правила` у ROLE → `## Робочий стиль`).
- **Telegraph table rendering** виправлено — правильне збереження column alignment і ізоляція state між таблицями.

### Виправлено
- Cron-задачі тепер створюються коректно — агент розуміє `schedule` параметр через consolidated CreateReminder секцію з прикладами. Раніше `_tools.md` згадував лише одноразові нагадки, що призводило до `CreateReminder(remindAt=...)` замість `schedule="0 9 * * *"`.
- Усунуто дублі SOUL секції в зібраному CLAUDE.md (міграційний скрипт раніше копіював цілком при будь-якій розбіжності).
- Усунуто стале правило `context/memories/YYYY-MM-DD.md` у role template що суперечило новій CreateReminder секції.
- Усунуто структурний дрейф: правка `roles/_tools.md` тепер миттєво долітає до всіх ботів, немає snapshot'ів на диску.

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
