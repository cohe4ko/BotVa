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
GenerateImage, EditImage, TextToSpeech, SendMedia, PublishTelegraph, ShareFile,
ListGalleryImages, SendGalleryImage, DeleteGalleryImage,
CreateBackup, ListBackups, VerifyBackup, RestoreBackup, SendEmail

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

При значущих змінах в коді, архітектурі, інструментах або конфігурації -- оновлюй `README.md`.
Особливо: нові інструменти (builtin tools), нові env-змінні, нові команди, зміни в адмін-панелі.

## Архітектура даних

**КОД (git tracked):**
- `src/`, `scripts/`, `roles/` — код, скрипти, шаблони ролей
- `mcp-servers/` — MCP сервери (без `build/`, `venv/`, `node_modules/`)
- `.claude/skills/` — скіли Claude Code
- `*.example` файли — шаблони без credentials

**ДАНІ (gitignored):**
- `bots/`, `knowledge/`, `store/` — персональні дані, БД
- `.env`, `.mcp.json`, `mcp-servers.json` — токени, ключі, шляхи
- `workspace/` — runtime дані ботів
- `agents/` — agent configs з персональними даними
