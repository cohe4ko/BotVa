# BotVa

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org)

Мульти-бот Telegram-платформа на базі Claude AI. Один сервер -- багато ботів, кожен зі своєю роллю, пам'яттю, знаннями та інтеграціями.

## Чим BotVa відрізняється

- **Пам'ять як першокласна сутність.** SQLite з salience-моделлю (факти згасають з коефіцієнтом 0.98/день, підсилюються при зверненні) + щоденні markdown-конспекти. О 4 ранку бот узагальнює день через Claude і оновлює KEY_EVENTS.md
- **Команда ботів.** Боти спілкуються через Unix-сокети (Colleague MCP), менеджер розподіляє задачі паралельно. Захист від рекурсії при делегуванні
- **Повна ізоляція.** Кожен бот -- окремий .env, база, знання, пам'ять, голос, роль. Всі працюють з одного процесу та керуються з однієї адмін-панелі
- **Живе управління.** Веб-панель для створення ботів, редагування .env, галереї зображень, cron-задач, бекапів, діагностики -- без рестартів
- **Динамічні інтеграції.** MCP-сервери підключаються за наявності env-змінних -- додав `BITRIX24_WEBHOOK_URL` і бот отримав CRM. Без зміни коду
- **Філософія.** Базова роль (`_soul.md`) -- маніфест: як думати, як спілкуватись, коли мовчати. Не "certainly!", а людська розмова

## Ключові можливості

- **Кілька ботів** з одного інстансу Node.js
- **13 готових ролей** -- від персонального асистента до вебмайстра
- **Пам'ять** -- факти (довгострокова) + щоденні diary-логи з консолідацією
- **Голос** -- голосові повідомлення та відповіді (Groq STT + Edge TTS)
- **Зображення** -- генерація та редагування через Gemini з авто-галереєю
- **Gemini AI** -- друга думка (AskGemini) та пошук з цитатами (GeminiSearch)
- **Команда ботів** -- спілкування через Unix-сокети, делегування задач
- **Планувальник** -- cron-задачі з повним доступом до інструментів
- **Утиліти** -- курси валют, час, Python sandbox, email, Telegraph
- **Інтеграції** -- CRM, реклама, Google Workspace, розумний дім, PubMed
- **Веб-пошук** -- пошук, скрапінг, AI-браузер (Stagehand)
- **Адмін-панель** -- повний веб-інтерфейс для управління
- **Бекапи** -- повні та per-bot, з SHA256-верифікацією

## Швидкий старт

### Вимоги

- Node.js 20+
- macOS або Linux
- Git

### Встановлення

```bash
# 1. Клонувати
git clone <repo-url> BotVa
cd BotVa

# 2. Встановити залежності та зібрати
./scripts/deploy.sh setup

# 3. Створити першого бота (варіант A: CLI)
npm run new-bot -- my-bot personal-assistant --emoji 🧑‍💼 --name "Мій Бот"

# 3. Створити першого бота (варіант B: веб-інтерфейс)
npm run admin              # Запустити адмін-панель
#    Відкрий http://localhost:3000 → Create Bot

# 4. Налаштувати токени
#    Відкрий bots/my-bot/.env:
#    - TELEGRAM_BOT_TOKEN  (отримати у @BotFather в Telegram)
#    - ALLOWED_CHAT_ID     (надіслати /chatid боту після запуску)

# 5. Запустити
./scripts/deploy.sh start
```

Після запуску напиши боту в Telegram -- він відповість.

## Ролі ботів

При створенні бота обираєш роль -- вона визначає спеціалізацію, інструменти та стиль.

| Роль | Slug | Опис |
|------|------|------|
| Персональний асистент | `personal-assistant` | Повсякденні задачі, розклад, CRM, розумний дім |
| Дослідник | `researcher` | Глибокий аналіз, верифікація фактів, звіти |
| Здоров'я | `health-advisor` | Моніторинг показників, аналізи, рекомендації |
| Академічний | `academic` | Наукові статті, методологія, PhD, викладання |
| Креативний | `creative` | Дизайн, зображення, презентації, копірайтинг |
| Продажі | `sales` | Ліди, угоди, аналіз продажів, пропозиції |
| Планувальник | `planner` | Задачі, дедлайни, пріоритизація |
| База знань | `knowledge-base` | Документація, FAQ, пошук знань |
| Менеджер | `manager` | Координація команди ботів, делегування |
| Продукт/Ринок | `product-market` | CRM-аналітика, позиціонування, конкуренти |
| Вебмайстер | `webmaster` | Сайт, контент, деплой, SEO |
| Інженер розумного дому | `dome-engineer` | Автоматизація, сценарії, Home Assistant |
| Дебати та дослідження | `debate-researcher` | Аналіз з протилежних позицій |

```bash
npm run new-bot -- <slug> <роль> [--emoji 🤖] [--name "Назва"]
```

## Можливості

### Голос

Бот розуміє голосові повідомлення та може відповідати голосом. STT через Groq Whisper (потрібен `GROQ_API_KEY`), TTS через Edge-TTS (безкоштовно). Команда `/voice` вмикає/вимикає голосові відповіді.

### Зображення

Генерація та редагування через Gemini (`GOOGLE_API_KEY`). Команда `/img опис` або просто попроси в чаті. Всі зображення зберігаються в галереї.

### Пам'ять

Трирівнева система: факти (постійне сховище з topic та tags), щоденні markdown-логи, workspace-файли (USER.md, MEMORY.md). Консолідація о `NIGHT_OWL_HOUR`.

### Планувальник

Cron-задачі: `/schedule 0 9 * * * Що в мене на сьогодні?`. Стандартний 5-полевий cron.

### Команда ботів

Менеджер координує роботу, боти спілкуються через Colleague MCP (Unix-сокети). Кожен бот може звернутись до менеджера через `ask_manager()`.

### Telegram

SendMedia (фото, документи, альбоми), ForwardMessage, SetReaction, PinMessage, OpenWebApp (Mini App), AskUser (кнопки, poll).

### Утиліти

CurrencyRates (готівкові курси), GetCurrentTime, RunPython (sandbox), SendEmail (SMTP), PublishTelegraph.

### Workspace Files

Бот читає та оновлює свої файли між сесіями: USER.md (профіль), MEMORY.md (пам'ять) через ReadWorkspaceFile / WriteWorkspaceFile.

Детальний посібник: [MANUAL.md](MANUAL.md)

## Інтеграції

| Інтеграція | MCP-сервер | Потрібні змінні |
|------------|-----------|-----------------|
| Bitrix24 CRM | `bitrix24` | `BITRIX24_WEBHOOK_URL` |
| Meta/Facebook Ads | `meta-ads-mcp` | `META_ACCESS_TOKEN`, `META_APP_SECRET` |
| Google Calendar, Gmail, Drive | `google-workspace` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| Home Assistant | `home-assistant` | `HA_URL`, `HA_TOKEN` |
| PubMed (медичні дослідження) | `pubmed` | -- (Python 3) |
| Miro (дошки, діаграми) | `miro` | -- (remote HTTP, OAuth) |

## Адмін-панель

Веб-інтерфейс для управління ботами. Два способи запуску:

```bash
# 1. З Telegram (on-demand, автостоп через 20 хв)
/admin

# 2. Як окремий сервіс (постійний)
npm run admin
```

| Розділ | Що робить |
|--------|-----------|
| Dashboard | Статус ботів, запити, витрати, сервіси |
| Config | Модель, температура, env-змінні, workspace files |
| Knowledge | Файли знань бота |
| Facts | Пам'ять: перегляд, пошук, редагування |
| Tasks | Заплановані cron-задачі |
| Settings | Налаштування чатів, сесії |
| Usage | Аналітика токенів та витрат |
| System | Builtin tools, MCP servers, skills on/off |
| Images | Галерея згенерованих зображень |
| Logs | Аудит подій |
| Diagnostics | AI-діагностика системи |
| Backup | Створення та відновлення бекапів |
| Team | Управління командою ботів |
| Templates | Шаблони ролей |
| Terminal | Браузерний shell |
| Create Bot | Майстер створення нового бота |

Детальний посібник: [MANUAL.md](MANUAL.md)

## Telegram-команди

| Команда | Опис |
|---------|------|
| `/start` | Привітання та chat ID |
| `/chatid` | Показати chat ID |
| `/newchat`, `/forget` | Очистити сесію (пам'ять залишається) |
| `/voice` | Увімкнути/вимкнути голосові відповіді |
| `/img <опис>` | Згенерувати зображення |
| `/model` | Перемкнути модель (Opus/Sonnet/Haiku) |
| `/schedule <cron> <текст>` | Створити задачу |
| `/usage` | Статистика токенів |
| `/stats` | Inline-статистика on/off |
| `/lang` | Мова інтерфейсу |
| `/admin` | Адмін-панель |
| `/session` | Перегляд CLI-сесій |
| `/cancel` | Скасувати запит |

## Структура проекту

```
BotVa/
├── src/                    # Код платформи (TypeScript)
│   ├── index.ts            # Точка входу
│   ├── bot.ts              # Telegram бот
│   ├── agent.ts            # Claude agent з MCP
│   ├── builtin-tools.ts    # Вбудовані інструменти
│   ├── memory.ts           # Система пам'яті
│   ├── db.ts               # SQLite
│   ├── voice.ts            # STT/TTS
│   ├── imagen.ts           # Генерація зображень
│   ├── scheduler.ts        # Планувальник
│   └── admin/              # Веб адмін-панель
├── roles/                  # Шаблони ролей
│   ├── _soul.md            # Базовий характер (для всіх ботів)
│   ├── _tools.md           # Базовий routing інструментів
│   └── *.md                # Ролі (personal-assistant, researcher, ...)
├── mcp-servers/            # MCP сервери
│   ├── bitrix24/           # Bitrix24 CRM
│   ├── meta-ads-mcp/       # Meta/Facebook Ads
│   ├── colleague/          # Міжботова комунікація
│   ├── manager/            # Координація менеджером
│   └── pubmed/             # PubMed пошук
├── scripts/                # Скрипти управління
├── installer/              # Веб-інсталятор
├── bots/                   # Дані ботів (gitignored)
├── workspace/              # Runtime дані (gitignored)
├── .env.example            # Шаблон конфігурації
└── package.json
```

## Управління

```bash
./scripts/deploy.sh setup      # Встановити залежності, зібрати
./scripts/deploy.sh start      # Запустити всі боти
./scripts/deploy.sh stop       # Зупинити
./scripts/deploy.sh restart    # Перезапустити
./scripts/deploy.sh build      # Перезібрати TypeScript + MCP
./scripts/deploy.sh status     # Статус
./scripts/deploy.sh backup     # Бекап
./scripts/deploy.sh restore    # Відновлення
```

## Деплой

Детальний гайд з конфігурацією та всіма варіантами: [DEPLOY.md](DEPLOY.md)

## Технічний стек

- **Runtime**: Node.js 20+, TypeScript (strict)
- **Telegram**: Grammy
- **AI**: Anthropic Claude Agent SDK
- **Database**: SQLite (вбудований в Node.js)
- **Web**: Hono
- **Voice**: Edge-TTS (синтез), Groq Whisper (розпізнавання)
- **Images**: Google Gemini
- **Browser**: Stagehand / Playwright
- **Тести**: Vitest 4.x

## Як долучитись

Дивись [CONTRIBUTING.md](CONTRIBUTING.md).

## FAQ

**Як дізнатись свій chat ID?**
Запусти бота та надішли `/start` або `/chatid`.

**Як додати знання боту?**
Поклади .md або .txt файли в `bots/<name>/knowledge/`. Також через адмін-панель (Knowledge).

**Як підключити інтеграцію?**
Додай відповідні змінні в `.env` бота. Після перезапуску бот автоматично отримає інструменти.

**Як переїхати на інший сервер?**
Дивись розділ "Міграція" в [DEPLOY.md](DEPLOY.md).

## Ліцензія

MIT
