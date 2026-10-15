# Ітерація: TGAP, стоп-кнопка, сесії SDK, фонові задачі

Статус: фази 0–4, 6, 8 зроблено; 5 частково; 2b і 7 — чекають рішення; оновлення залежностей — у вікні рестарту. Дата: 2026-10-15.

## Що знайшлося під час підготовки (впливає на план)

1. **Guest mode не read-only.** `GUEST_ALLOWED_TOOLS` (`src/guest-mode.ts:19`) ніде не застосовується. При `GUEST_MCP_ALLOW_LIST = []` у `runAgent` іде `undefined` (`src/bot.ts:2506`), а це означає, що вантажаться **всі** MCP. Bash, Write і Edit у bypass-режимі теж доступні. Гість, який згадав бота в будь-якому чаті, фактично має повний агент.
2. **Colleague-запити без обмежень.** Відповідь на `ask_colleague` (`src/index.ts:94`) працює з повним набором інструментів.
3. **Фонові запуски ділять ключ черги з користувачем.** Consolidation і scheduler викликають `runAgent` з `chatId = ALLOWED_CHAT_ID`, тому перезаписують `abortControllers`/`activeQueries` живого запуску.
4. **Rich draft, ймовірна причина падіння — наш обхід.** У tdesktop issue #30945 мейнтейнер пояснив: drafts одного повідомлення мають іти з **тим самим** id. Ми ж навмисно ставимо новий випадковий `draftId` на кожен flush (`src/progress-reporter.ts:919`). У changelog 10.2/10.3 і релізах Desktop до 7.3.1 явного фіксу немає.
5. **`sessionStore` у SDK — `@alpha` і лише дзеркало.** Локальні `.jsonl` лишаються обов'язковими. Від них залежать `disk-sessions.ts`, `consolidate.ts`, `session-compactor.ts`, `/undo` і адмінка.
6. **Справжні фонові задачі потребують постійного процесу.** Зараз кожне повідомлення — окремий `query()` зі string prompt, і після `result` процес CLI завершується разом з усіма фоновими задачами. Тож фонові задачі — це перехід на streaming input (один довгоживучий `query` на чат).
7. **Версії.** SDK 0.3.206 → 0.3.300: `prewarm()`/`SpareProcess` (0.3.282) і `perTaskStopAffordance` (0.3.246) є тільки в новій. grammY 1.44 → 1.46 (`@grammyjs/types` 3.28 → 5.0, мажорне оновлення типів): лише там є `can_stop`, `keep_on_stop` і `stopped_message_generation`.

## Фази (у порядку виконання)

### ✅ Фаза 0. Безпекові передумови
- Єдиний **read-only профіль запуску** в `agent.ts`: `permissionMode: 'default'` + `canUseTool`, який дозволяє лише allowlist, плюс `disallowedTools` для Bash/Write/Edit/NotebookEdit і `mcpAllowList` лише з read-інструментів. Це два незалежні шари: якщо один зламається, другий тримає.
- Guest mode переходить на цей профіль: реально застосувати `GUEST_ALLOWED_TOOLS`.
- Окремий ключ черги для фонових запусків (`bg:<kind>`), щоб вони не перетирали живий запуск користувача.
- Тести: профіль не пропускає жодного write-інструмента, guest отримує тільки allowlist.

### ✅ Фаза 1. Ізоляція RunPython
- Чисте оточення: тільки `PATH`, `LANG`, `HOME=<sandbox>`, `MPLBACKEND`, `PYTHONUNBUFFERED`, без жодного ключа з `process.env`.
- macOS: `sandbox-exec` з профілем, де мережа заборонена, запис дозволено тільки в `workspace/sandbox`, читання — системні шляхи й site-packages.
- Linux: `bwrap`, якщо доступний (`--unshare-net`, bind лише sandbox-каталогу). Якщо ні — чисте оточення й попередження в лог.
- Ліміти: CPU-час і пам'ять (`ulimit` / `resource.setrlimit` у bootstrap).
- Прибрати з опису інструмента `sympy` (його не встановлено) або встановити.
- Тести: з Python не видно `ANTHROPIC_API_KEY`/`TELEGRAM_BOT_TOKEN`, мережевий запит падає, запис поза sandbox падає.

### Фаза 2. TGAP Basic (`docs/tgap-spec.md`)
- `src/tgap/envelope.ts`: парсинг і рендер конверта (`pre` з `language: tgap`), валідація, великі payload'и через документ.
- `src/tgap/store.ts`: таблиці `tgap_peers` (id бота, username, trust, card), `tgap_messages` (дедуп і аудит), `tgap_requests` (стан, conv, turn, expires_at).
- `src/tgap/guard.ts`: ліміти з §7 (дедуп, turn/hop, rate limit на пира, не відповідати на non-eliciting), **до** будь-якого виклику моделі.
- Вхідний бік: приватне повідомлення від бота → guard → чернетка через **read-only профіль (фаза 0)**. Вхідний текст позначений як недовірені дані. Інструменти: SearchMemory, GetCurrentTime, read-інструменти календаря. Без WebFetch/WebSearch, бо URL з query-параметрами — канал витоку. Далі картка власнику з кнопками [Надіслати] [Змінити] [Відхилити] [Заблокувати] і `status: pending_approval` пиру.
- Вихідний бік: builtin-інструменти `AskExternalBot(username, question, expires?)` і `ManageExternalBot` (trust level, список). Відповіді зіставляються через `re`, власнику доповідається з чесним статусом `approval`.
- Сповіщення про `expired`.
- Ручний крок: увімкнути Bot-to-Bot Communication Mode у BotFather для кожного бота.
- Фаза 2b (Extended): `proposal` / `decision` / `counter`, мандат на боці запитувача.
- Документація: каталог інструментів у `CLAUDE.md`, `README.md`, ролі.

### ✅ Фаза 3. Стоп-кнопка + rich draft (без оновлення grammY)
- Зроблено на grammY 1.44: `can_stop`/`keep_on_stop` передаються як є, апдейт `stopped_message_generation` читається з `ctx.update`. Стабільний `draft_id` на хід. Оновлення до 1.46 — у вікні рестарту, не обов'язкове.
- Лишилось: ручний тест rich draft на Desktop 7.3.1 + телефон.

- Оновити `grammy` і `@grammyjs/runner`, виправити типи після переходу на types 5.0.
- Drafts: **один стабільний `draft_id` на хід**, throttle 500–1000 мс, `can_stop: true`, `keep_on_stop: true`.
- Апдейт `stopped_message_generation` → мапа `draft_id → chatId` → `interruptRequest`. Частковий текст зберігається новим повідомленням.
- Перевірити, що `stopped_message_generation` потрапляє в `allowed_updates`.
- Ручний тест (Іван): Desktop 7.3.1 macOS/Windows + iOS/Android, довга відповідь з таблицями й кодом. Якщо стабільно, `rich_draft` стає увімкненим за замовчуванням.

### ✅ Фаза 4. `outputFormat` (structured outputs)
Перевести на `outputFormat: { type: 'json_schema', schema }` (замість ручного зрізання fence + `JSON.parse`):
- `listener-analyze.ts:202`
- `telegram/analyze-conversation.ts:170`
- `admin/routes/bot-facts.ts:552`
- `admin/routes/bot-diagnostics.ts:266`
- `admin/routes/diagnostics.ts:900`

Схеми лежать поруч з кодом і з тих самих TS-типів, тести є на кожну.

### Фаза 5. SDK: `forkSession` ✅, `prewarm` і `sessionStore` — окремо
- ✅ `/fork` — нова гілка розмови з тим самим контекстом через `forkSession` (є вже в 0.3.206); попередня гілка лишається в `/session`. Перевірено на реальній сесії.
- ⏸ **Оновлення SDK 0.3.206 → 0.3.300 — тільки у вікні рестарту.** Кожен `query()` запускає CLI з `node_modules`: якщо підмінити пакет під живим ботом, старий SDK у пам'яті говоритиме з новим CLI. Разом з оновленням: `prewarm()`/`SpareProcess` (0.3.282) — запасний «теплий» процес; `startup()` з 0.3.206 не підходить, бо вимагає опцій наперед, а в нас вони щоходу різні (сесія, builtin-сервер з ctx, модель).
- ⛔ **`sessionStore` не вмикаємо.** Експеримент: з `sessionStore` при `resume` CLI пише нові записи в тимчасовий файл і в сховище, а **не в локальний `.jsonl`** (рядків не додалось). На локальних файлах тримаються `/undo`, консолідація, відновлення після збою, адмінка — все це тихо зламалося б. Інтеграція можлива лише як окремий рефакторинг «сховище — джерело істини» з перенесенням усіх читачів.

### ✅ Фаза 6. Режим сесій: NameSession або топіки
- Налаштування `session_mode = name | topics` у `/settings` (патерн `think_lang`). За замовчуванням `name`, тобто як зараз.
- `topics`: ключ сесії `chatId:threadId`, `message_thread_id` у всіх відправках (AskUser, progress, drafts, rich, chat action, фото RunPython), `NameSession` перейменовує топік (`editForumTopic`), `/new` створює топік.
- Ручний крок: увімкнути topics mode для бота в BotFather.

### ⏸ Фаза 7. Фонові задачі — чекає рішення
- Експеримент (SDK 0.3.206): з рядковим prompt фонова задача вбивається, щойно хід закінчився (`task_notification: stopped`). У streaming input — доживає, і модель сама відкриває новий хід з результатом. Отже потрібен довгоживучий процес на чат.

- Перехід на streaming input: один довгоживучий `query` на чат, нові повідомлення йдуть через `streamInput`. Це найбільша архітектурна зміна ітерації.
- `perTaskStopAffordance`: «Стоп» зупиняє лише поточний хід, фонові задачі живуть далі.
- `background_tasks_changed` — живий список задач; команда `/tasks` з кнопками зупинки (`stopTask`).
- Коли задача завершилась (`task_notification`), бот сам надсилає результат у чат.
- Бот відповідає на нові повідомлення, поки задача працює у фоні.
- Ризики: watchdog, `/undo` і рестарти треба адаптувати до довгоживучого процесу.

### ✅ Фаза 8. Автовідповідач через Telegram Business (Chat Automation)
Принцип поділу:
- **Реактивне** (хтось написав власнику, бот відповідає) йде через Business API.
- **Проактивне** (власник або бот пише першим, відповіді поза вікном 24 год) і **стеження** (читання чатів, Tier1-факти, пошук по архіву, контакти) лишаються на MTProto-обсервері.

Кроки:
- grammY: обробники `business_connection`, `business_message`, `edited_business_message`, `deleted_business_messages`. Таблиця `business_connections` (id, user, rights, is_enabled), оновлюється на кожному апдейті; на старті звірка через `getBusinessConnection`.
- Відповідь: та сама довгоживуча сесія на чат `tg:<chat_id>` і той самий prompt-контекст, що в `telegram-autoreply.ts` (історія, голос власника). Відправка через `sendMessage` з `business_connection_id`, «друкує» через `sendChatAction`, позначка прочитаного — `readBusinessMessage`.
- Перехоплення власником: вихідний `business_message` від власника (`from.id == connection.user.id`) ставить AI в цьому чаті на паузу, як зараз робить gate.
- Маршрутизатор у `telegram-autoreply.ts`: якщо особистий чат покритий business-підключенням з `can_reply`, MTProto-автовідповідь для нього вимикається, щоб не було дублів. Обсервер при цьому далі читає й логує цей чат для фактів і пошуку.
- Групи: Business їх не підтримує. Групова автовідповідь лишається на MTProto, як зараз (до окремого рішення).
- Адмінка, розділ Telegram: статус підключення, права, які чати покриває Business, а які MTProto.
- Обмеження, які треба врахувати: одне підключення на акаунт, тільки особисті чати, лише нові повідомлення (історію дає обсервер), відповідь лише протягом 24 год після вхідного.
- Ручні кроки: Secretary Mode у BotFather для бота; Settings → Chat Automation в акаунті власника.
- Документація: `README.md`, `docs/telegram-observer.md`.
- Ризик: `npm install` під час фази 3 перезапускає `postinstall` з патчем GramJS до layer 222 (`scripts/patch-gramjs.mjs`). Після кожного оновлення залежностей обов'язково проганяти `src/telegram/gramjs-layer.test.ts`.

## Застосування змін
Кожна фаза — окремий коміт з тестами (`npm test`, `npm run typecheck`). Рестарт ботів через `scripts/deploy.sh restart` — тільки з підтвердження Івана.
