# BotVa

## Git

При значущих правках -- автоматично комітити зміни. Не питати дозволу на коміт.

### Що комітити

**Комітити (код платформи):**
- `src/`, `scripts/`, `roles/` -- код, скрипти, шаблони ролей
- `mcp-servers/` -- MCP сервери (тільки вихідний код, без `build/`, `venv/`, `node_modules/`)
- `.claude/skills/` -- скіли Claude Code
- `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- `CLAUDE.md`, `DEPLOY.md`, `README.md`
- `mcp-servers.json.example`, `.mcp.json.example`

**НЕ комітити (дані та секрети):**
- `bots/` -- конфіги, knowledge, context, .env конкретних ботів
- `knowledge/` -- персональні дані користувача
- `store/` -- SQLite бази
- `.env`, `.mcp.json` -- токени, ключі, webhook URLs
- `workspace/` -- runtime дані ботів
- `agents/` -- agent configs з персональними даними
- Будь-які API ключі, bot tokens, паролі, email адреси, chat ID

### Автор комітів

Для комітів у цей репо використовуй:
```
--author="BotVa <dev@botva.app>"
```

### Коміт-повідомлення

- Не включати персональні дані в коміт-повідомлення (імена, діагнози, прізвища)
- Не додавати `Co-Authored-By`
- Формат: `тип: короткий опис` (feat, fix, refactor, add, docs)

### Remotes та push

Репозиторій має два remote:
- `private` (github.com/cohe4ko/BotVaPrivate) -- приватний, дефолтний
- `origin` (github.com/cohe4ko/BotVa) -- **ПУБЛІЧНИЙ, read-only для агента**

**ЗАБОРОНЕНО:** агент НЕ має права пушити в `origin` (публічний repo). Ніколи не виконувати `git push origin`. Публікація в origin -- виключно ручна дія користувача.

- `git push` -- йде в private (безпечно, агент може виконувати)
- `git push origin ...` -- **ЗАБОРОНЕНО для агента**

### Перед push

Завжди перевіряй `git diff --cached` на наявність:
- Токенів (`AAF`, `AAH`, `AAG`, `AAE`, `gsk_`, `AIzaSy`)
- Email адрес
- Webhook URLs
- Імен, прізвищ, медичних даних
- Шляхів з іменами користувачів (`/Users/ivan/`, `/home/vika/`)

## Ролі ботів

Файли `roles/*.md` -- шаблони системних промптів для ботів.

### Як це працює

1. `_soul.md` -- характер, правила, формат, workspace files (-> SOUL.md)
2. `_tools.md` -- generic tool routing, SaveFact, AskUser (-> TOOLS.md base)
3. Кожна роль -- шаблон з маркерами `--- IDENTITY/ROLE/TOOLS ---` та плейсхолдерами `{{BOT_NAME}}`, `{{BOT_EMOJI}}`
4. При створенні бота: `buildWorkspaceFilesFromRole()` в `src/workspace-files.ts` збирає workspace files напряму
5. Результат -> `bots/<name>/workspace-files/` + `bots/<name>/CLAUDE.md`

### Обов'язкова структура файлу ролі

```
--- IDENTITY ---
# {{BOT_NAME}} {{BOT_EMOJI}}
Ти -- {{BOT_NAME}}, [конкретна роль].     ← НЕ "helpful assistant"

--- ROLE ---
## Спеціалізація                          ← 5-8 конкретних пунктів
## Правила                                ← guardrails + domain safety
## Робочі сценарії                        ← 2-3 покрокових workflows
## Формат відповідей                      ← стиль для Telegram

--- TOOLS ---
## Коли який інструмент                   ← НАЙВАЖЛИВІША СЕКЦІЯ (trigger->action->when NOT)
```

### Секція "Коли який інструмент" -- як писати

Це найважливіша секція. Без неї бот не знає КОЛИ використовувати інструменти.

Формат таблиці:
| Що просить користувач | Що робити | Коли НЕ цей |

Принципи:
- Лівий стовпець: фрази КОРИСТУВАЧА ("увімкни світло", "знайди статтю")
- Середній: конкретний tool (GenerateImage, WebSearch, google_calendar_create)
- Правий: коли НЕ використовувати цей tool (найважливіший стовпець для якості routing)
- Якщо MCP має різні tools -- вказувати конкретний tool name
- Для складних сценаріїв: 2-3 few-shot приклади (запит -> дії бота)
- Тільки релевантні для ролі tools, не всі підряд

### Каталог доступних інструментів

**Builtin tools** (src/builtin-tools.ts):
GenerateImage, EditImage, TextToSpeech, SendMedia, SetReaction, ForwardMessage, PublishTelegraph, ShareFile,
ListGalleryImages, SendGalleryImage, DeleteGalleryImage,
CreateBackup, ListBackups, VerifyBackup, RestoreBackup, DeleteBackup, SendEmail,
SaveFact, SearchMemory, DeleteFact, BoostFact,
CreateBot, DeleteBot, ListBots,
CurrencyRates, GetCurrentTime,
CreateReminder, ListReminders, DeleteReminder,
RunPython, AskUser, TakeScreenshot, NameSession,
AskGemini, GeminiSearch,
PinMessage, OpenWebApp, SendLocation, SendSticker, SendAnimation,
ReadWorkspaceFile, WriteWorkspaceFile

**MCP сервери** (mcp-servers.json):
- google-workspace -- Calendar, Gmail, Drive
- home-assistant -- розумний дім
- stagehand -- AI-браузер (act, extract, observe)
- playwright-remote -- headless Chrome
- Будь-який MCP сервер можна додати через `mcp-servers.json` (див. нижче)

### Як підключити MCP інтеграцію

1. Знайти MCP сервер (npm, pypi, або локальний)
2. Додати запис в `mcp-servers.json`:
```json
"my-server": {
  "command": "npx",
  "args": ["my-mcp-server"],
  "envVars": ["MY_API_KEY"],
  "envPassthrough": ["MY_API_KEY"],
  "enabled": true
}
```
3. Додати env vars в `.env` бота
4. Увімкнути/вимкнути в адмінці: System → MCP Servers

**Типи серверів:**
- `npx <package>` -- npm-пакети (playwright, stagehand)
- `uvx <package>` -- Python-пакети (google-workspace, home-assistant)
- `node path/to/server.js` -- локальні Node.js сервери
- `python path/to/server.py` -- локальні Python сервери
- Remote HTTP/SSE: додати `"type": "http"`, `"url": "https://..."` замість command/args

**Skills** (~/.claude/skills/):
deep-research, article-extractor, youtube-transcript, content-research-writer,
pptx, ship-learn-next

**Команда:**
- ask_manager("питання") -- для звичайних ботів
- ask_colleague(bot, "задача") -- для менеджера

### Чеклист якості ролі

При створенні або редагуванні ролі:
- [ ] Файл має маркери `--- IDENTITY ---`, `--- ROLE ---`, `--- TOOLS ---`
- [ ] Є "Коли який інструмент" з таблицею trigger->action->when NOT
- [ ] Trigger написані мовою КОРИСТУВАЧА (не розробника)
- [ ] Tools конкретні (google_calendar_list, не "Calendar")
- [ ] Для кожного tool є "Коли НЕ використовувати"
- [ ] Є 2-3 робочих сценарії (workflows) з кроками
- [ ] Є guardrails (що НЕ робити)
- [ ] Немає дублювання з _soul.md або _tools.md
- [ ] Розмір: 30-80 рядків (без base files)

## Документація

### Коли оновлювати

Оновлюй документацію **в тому ж коміті** або одразу після коміту з кодом, якщо зміна потрапляє хоча б в одну категорію:

| Що змінилось | Що оновити |
|---|---|
| Новий/видалений **builtin tool** | 1. Каталог інструментів в цьому файлі 2. `README.md` — секція "Утиліти" або відповідна 3. `roles/*.md` — таблиця "Коли який інструмент" якщо релевантний |
| Нова/змінена **Telegram-команда** | `README.md` — таблиця "Telegram-команди" |
| Новий розділ / вкладка **адмін-панелі** | `README.md` — таблиця "Розділи" в секції "Адмін-панель" |
| Нова **env-змінна** | `README.md` — відповідна таблиця в секції "Конфігурація" + `.env.example` |
| Новий/видалений **MCP-сервер** | 1. Каталог в цьому файлі 2. `README.md` — таблиця "Інтеграції" |
| Нова **роль бота** | `README.md` — таблиця "Ролі ботів" |
| Зміни в **архітектурі, структурі проекту** | `README.md` — "Структура проекту" та "Структура бота" |
| Новий **npm script / deploy.sh subcommand** | `README.md` — секції "npm scripts" / "deploy.sh" |

### Як оновлювати

1. **Прочитай поточний README.md** перед редагуванням — зрозумій стиль, формат таблиць, рівень деталізації
2. **Дотримуйся існуючого формату** — якщо це таблиця, додай рядок в таблицю; якщо список — додай пункт
3. **Коротко і конкретно** — одне речення на фічу, без маркетингу. Дивись на сусідні рядки як зразок
4. **Не дублюй** — якщо фіча вже описана (наприклад через попередній коміт), не додавай повторно
5. **Фікси не документуються** — баг-фікси, рефакторинг, UI-правки не потребують змін в README

## Тести

Фреймворк: vitest 4.x. Тести поруч з кодом: `src/foo.ts` → `src/foo.test.ts`.

### Запуск

```bash
npm test                                  # всі тести
npx vitest run src/bounded-map.test.ts    # один файл
npx vitest run --coverage                 # з coverage
```

### Правила

- **При зміні модуля** — оновити або додати відповідний `.test.ts` файл
- **При додаванні нового модуля в `src/`** — створити `*.test.ts` поруч
- **Мокати зовнішні залежності** (`./config.js`, `./db.js`, `./logger.js`, `./env.js`), не реальні сервіси
- **Для `db.test.ts`** — використовувати temp dir через `vi.hoisted()`, не production базу
- **Тести не мають містити** персональних даних, реальних токенів, шляхів з іменами користувачів
- **Після додавання тестів** — переконатися що `npm test` проходить перед комітом

### Структура тесту

```ts
import { describe, it, expect, vi } from 'vitest'

// Мокаємо залежності перед імпортом модуля
vi.mock('./config.js', () => ({ ... }))
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), ... } }))

import { myFunction } from './my-module.js'

describe('myFunction', () => {
  it('does something', () => {
    expect(myFunction('input')).toBe('expected')
  })
})
```

## Архітектура даних

**КОД (git tracked):**
- `src/`, `scripts/`, `roles/` — код, скрипти, шаблони ролей
- `mcp-servers/` — MCP сервери (без `build/`, `venv/`, `node_modules/`)
- `.claude/skills/` — скіли Claude Code
- `*.example` файли — шаблони без credentials

**ДАНІ (gitignored):**
- `bots/`, `knowledge/`, `store/` — персональні дані, БД
- `bots/<name>/workspace-files/` — per-bot workspace файли (див. нижче)
- `.env`, `.mcp.json`, `mcp-servers.json` — токени, ключі, шляхи
- `workspace/` — runtime дані ботів
- `agents/` — agent configs з персональними даними

### Workspace files (8 шарів CLAUDE.md)

CLAUDE.md бота збирається на льоту з 8 шарів. Два з них — **глобальні** (живуть у `roles/`, спільні для всіх ботів), решта — **per-bot** (на диску в `bots/<name>/workspace-files/`).

| Файл | Тип | Джерело | Editable |
|---|---|---|---|
| `IDENTITY.md` | per-bot | seed з role-шаблону | адмінка |
| `SOUL.md` | **global** | `roles/_soul.md` (runtime) | тільки git |
| `BOT_SOUL.md` | per-bot | overlay характеру конкретного бота | адмінка |
| `ROLE.md` | per-bot | seed з role-шаблону | адмінка |
| `TOOLS.md` | **global** | `roles/_tools.md` (runtime) | тільки git |
| `BOT_TOOLS.md` | per-bot | role-specific tool routing з role-шаблону | адмінка |
| `USER.md` | per-bot | бот-writable (`WriteWorkspaceFile`) | бот + адмінка |
| `MEMORY.md` | per-bot | бот-writable (`WriteWorkspaceFile`) | бот + адмінка |

**Assembly order:** `IDENTITY → SOUL → BOT_SOUL → ROLE → TOOLS → BOT_TOOLS → USER → MEMORY`

Глобальні `SOUL.md`/`TOOLS.md` НЕ зберігаються на диску у ботів — `assembleFromWorkspaceFiles()` читає їх з `roles/_soul.md` / `roles/_tools.md` при кожному виклику. Це означає: правка `roles/_*.md` миттєво долітає до всіх ботів. Editable per-bot файли — IDENTITY/BOT_SOUL/ROLE/BOT_TOOLS — редагуються тільки через адмінку чи вручну. USER.md/MEMORY.md пише сам бот через `WriteWorkspaceFile`.

**Replace-marker (`<!-- REPLACES_GLOBAL -->`)**: за замовчуванням `BOT_SOUL.md`/`BOT_TOOLS.md` *доповнюють* глобальний шар (інжектяться після). Якщо потрібен авторський бот з повністю своїм характером (як `ai`/Sol), додай у перший рядок `BOT_SOUL.md` маркер `<!-- REPLACES_GLOBAL -->` — глобальний `SOUL.md` буде пропущений під час асемблювання. Аналогічно для `BOT_TOOLS.md` ↔ `TOOLS.md`. Маркер вирізається з виводу.

**Conditional sections (feature flags)**: блоки `<!-- IF FEATURE -->...<!-- END -->` у `_soul.md` (та інших шарах) інжектяться лише якщо відповідний прапорець у `bots/<name>/.env` має значення `1`/`true`. Підтримувані прапорці:
- `GROUP_CHAT_ENABLED` — групові Telegram-чати (multi-bot dialogue)
- `DEV_MODE_ENABLED` — режим планування коду (AskUser перед змінами)
- `GIT_ACCESS_ENABLED` — git workflow (commit conventions, ask before push)

Дефолт у новостворених ботів — все `0`. Прапорці додаються в `.env` бота вручну. Список — у `src/workspace-files.ts → FEATURE_FLAGS`.

**Контракт шарів**: повний контракт "що в якому шарі живе" — у `roles/SHARDS.md`. Це джерело істини для будь-яких правок workspace-files. Без нього шари неминуче дрейфують у дублі. Перед правкою `_soul.md`, `_tools.md`, role template або BOT_SOUL/BOT_TOOLS — звірся з SHARDS.md → "Канонічна мапа топіків".

**Hierarchy markers (emoji legend)**: у `_soul.md` визначений набір emoji-маркерів обов'язковості: 🔒 інваріант, 💡 рекомендація, 🎯 приклад, ✅ правильний патерн, ❌ анти-патерн, 📌 фонова інформація. Використовуються в усіх shards без слів-тегів. Розшифровка — один раз у `_soul.md` (або в `BOT_SOUL.md` для REPLACES_GLOBAL ботів).

**Lint правила**: `src/workspace-files-contract.test.ts` перевіряє інваріанти на кожен запуск `npm test`: відсутність дублів h2, відсутність over-mention tools, наявність behavioral anchors (≥10 ❌/✅ пар), наявність 🔒 markers, очищення IF/REPLACES_GLOBAL маркерів, розмір ≤30 KB. Падіння тесту = структурна регресія, треба фіксити shard, а не послаблювати правило.

**Admin lint**: при відкритті редактора `BOT_SOUL.md`/`BOT_TOOLS.md` адмінка обчислює jaccard similarity з відповідним global шаром (4-грами рядків) і показує warning якщо ≥80% (жовтий) або ≥95% (червоний) — підказує усунути дубль або додати `<!-- REPLACES_GLOBAL -->`.
