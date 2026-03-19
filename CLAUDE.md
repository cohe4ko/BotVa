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

1. `_base.md` -- спільна основа (soul, правила, інструменти). Включається через `{{включено _base.md}}`
2. Кожна роль -- повний шаблон з плейсхолдерами `{{BOT_NAME}}`, `{{BOT_EMOJI}}`
3. При створенні бота: `buildClaudeMd()` в `src/admin/routes/create-bot.ts` інлайнить _base.md і замінює плейсхолдери
4. Результат -> `bots/<name>/CLAUDE.md` (системний промпт для Claude Agent SDK)

### Обов'язкова структура файлу ролі

```
# {{BOT_NAME}} {{BOT_EMOJI}}
Ти -- {{BOT_NAME}}, [конкретна роль].     ← НЕ "helpful assistant"

## Soul
{{включено _base.md}}

## Спеціалізація                          ← 5-8 конкретних пунктів
## Правила                                ← guardrails + domain safety
## Ресурси -- прочитай ПЕРЕД відповіддю    ← файли для контексту
## Коли який інструмент                   ← НАЙВАЖЛИВІША СЕКЦІЯ (trigger->action->when NOT)
## Робочі сценарії                        ← 2-3 покрокових workflows
## Взаємодія з командою                   ← ask_manager / ask_colleague
## Формат відповідей                      ← стиль для Telegram
```

### Секція "Коли який інструмент" -- як писати

Це найважливіша секція. Без неї бот не знає КОЛИ використовувати інструменти.

Формат таблиці:
| Що просить користувач | Що робити | Коли НЕ цей |

Принципи:
- Лівий стовпець: фрази КОРИСТУВАЧА ("увімкни світло", "знайди статтю")
- Середній: конкретний tool (bitrix24_create_lead, GenerateImage, WebSearch)
- Правий: коли НЕ використовувати цей tool (найважливіший стовпець для якості routing)
- Якщо MCP має різні tools -- вказувати конкретний tool name
- Для складних сценаріїв: 2-3 few-shot приклади (запит -> дії бота)
- Тільки релевантні для ролі tools, не всі підряд

### Каталог доступних інструментів

**Builtin tools** (src/builtin-tools.ts):
GenerateImage, EditImage, TextToSpeech, SendMedia, SetReaction, ForwardMessage, PublishTelegraph, ShareFile,
ListGalleryImages, SendGalleryImage, DeleteGalleryImage,
CreateBackup, ListBackups, VerifyBackup, RestoreBackup, DeleteBackup, SendEmail,
SaveFact, SearchMemory, DeleteFact,
CreateBot, DeleteBot, ListBots,
CurrencyRates, GetCurrentTime,
CreateReminder, ListReminders, DeleteReminder,
RunPython, AskUser, TakeScreenshot, NameSession,
AskGemini, GeminiSearch,
ReadWorkspaceFile, WriteWorkspaceFile

**MCP сервери** (mcp-servers.json):
- bitrix24 -- CRM: контакти, ліди, угоди, компанії, звіти
- google-workspace -- Calendar, Gmail, Drive
- home-assistant -- розумний дім
- meta-ads -- Facebook/Instagram реклама
- stagehand -- AI-браузер (act, extract, observe)
- pubmed -- наукові статті (медицина)
- playwright-remote -- headless Chrome

**Skills** (~/.claude/skills/):
deep-research, article-extractor, youtube-transcript, content-research-writer,
pptx, ship-learn-next

**Команда:**
- ask_manager("питання") -- для звичайних ботів
- ask_colleague(bot, "задача") -- для менеджера

### Чеклист якості ролі

При створенні або редагуванні ролі:
- [ ] Є "Коли який інструмент" з таблицею trigger->action->when NOT
- [ ] Trigger написані мовою КОРИСТУВАЧА (не розробника)
- [ ] Tools конкретні (bitrix24_get_deal, не "CRM")
- [ ] Для кожного tool є "Коли НЕ використовувати"
- [ ] Є 2-3 робочих сценарії (workflows) з кроками
- [ ] Є guardrails (що НЕ робити)
- [ ] Є "Ресурси" з інструкцією "прочитай ПЕРЕД відповіддю"
- [ ] Немає дублювання з _base.md
- [ ] Розмір: 40-100 рядків (без _base.md)

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

## Архітектура даних

**КОД (git tracked):**
- `src/`, `scripts/`, `roles/` — код, скрипти, шаблони ролей
- `mcp-servers/` — MCP сервери (без `build/`, `venv/`, `node_modules/`)
- `.claude/skills/` — скіли Claude Code
- `*.example` файли — шаблони без credentials

**ДАНІ (gitignored):**
- `bots/`, `knowledge/`, `store/` — персональні дані, БД
- `bots/<name>/workspace-files/` — workspace файли бота (SOUL.md, USER.md, MEMORY.md тощо)
- `.env`, `.mcp.json`, `mcp-servers.json` — токени, ключі, шляхи
- `workspace/` — runtime дані ботів
- `agents/` — agent configs з персональними даними
