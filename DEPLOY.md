# BotVa -- Деплой

## Варіанти встановлення

| Варіант | Для кого | Час |
|---------|----------|-----|
| [Локально](#локальне-встановлення) | Розробка, macOS/Linux | 5 хв |
| [Веб-інсталятор](#веб-інсталятор) | Новий VPS (DigitalOcean тощо) | 3-7 хв |
| [Docker](#docker) | Контейнерне середовище | 5 хв |

## Локальне встановлення

### Вимоги

- Node.js 20+ (`node --version`)
- macOS або Linux
- Git

### Кроки

```bash
# 1. Клонувати
git clone https://github.com/cohe4ko/BotVa.git BotVa
cd BotVa

# 2. Встановити залежності та зібрати
./scripts/deploy.sh setup

# 3. Створити бота (CLI або через адмін-панель)
npm run new-bot -- my-bot personal-assistant --emoji 🧑‍💼 --name "Мій Бот"

# 4. Налаштувати токени
#    Відкрий bots/my-bot/.env та встанови:
#    - TELEGRAM_BOT_TOKEN  (отримати у @BotFather)
#    - ALLOWED_CHAT_ID     (надіслати /chatid боту)

# 5. Запустити
./scripts/deploy.sh start
```

Також можна створити бота через веб: `npm run admin` → http://localhost:3000 → Create Bot.

## Веб-інсталятор

Автоматичне встановлення на новий сервер через веб-форму. Підтримує DigitalOcean, будь-який Ubuntu VPS.

Детальна інструкція: [installer/README.md](installer/README.md)

```bash
cd installer
npm install
npm start
# Відкриється http://localhost:3456
```

Інсталятор можна розгорнути як standalone сервіс:

- **Render** -- `render.yaml` Blueprint (безкоштовно)
- **Railway** -- auto-detect Node.js
- **Docker** -- `docker build -t botva-installer . && docker run -p 3456:3456 botva-installer`

## Docker

```bash
cd installer
docker build -t botva-installer .
docker run -p 3456:3456 botva-installer
```

Для деплою самого BotVa в Docker -- використовуйте веб-інсталятор або ручне встановлення на VPS.

## Конфігурація

Кожен бот має свій `.env` файл в `bots/<name>/.env`. Шаблон: [.env.example](.env.example).

### Обов'язкові

| Змінна | Опис |
|--------|------|
| `TELEGRAM_BOT_TOKEN` | Токен від @BotFather |
| `ALLOWED_CHAT_ID` | Твій Telegram chat ID |

### Google API

| Змінна | Опис |
|--------|------|
| `GOOGLE_API_KEY` | Для генерації зображень (Gemini) та Stagehand |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Workspace (Calendar, Gmail, Drive) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Workspace |
| `USER_GOOGLE_EMAIL` | Email акаунту Google |

### Голос

| Змінна | За замовчуванням | Опис |
|--------|-----------------|------|
| `GROQ_API_KEY` | -- | Ключ Groq для STT (безкоштовно: console.groq.com) |
| `GROQ_STT_MODEL` | `whisper-large-v3` | Модель розпізнавання |
| `TTS_RATE` | `+30%` | Швидкість синтезу мовлення |
| `TTS_VOICE_UK` | `uk-UA-OstapNeural` | Голос для української |
| `TTS_VOICE_EN` | `en-US-AndrewNeural` | Голос для англійської |
| `TTS_VOICE_RU` | `ru-RU-DmitryNeural` | Голос для російської |

### Моделі

| Змінна | За замовчуванням | Опис |
|--------|-----------------|------|
| `STAGEHAND_MODEL` | `google/gemini-2.5-flash` | Модель для AI-браузера |
| `IMAGEN_MODEL` | `gemini-3.1-flash-image-preview` | Модель генерації зображень |

### Адмін-панель

| Змінна | За замовчуванням | Опис |
|--------|-----------------|------|
| `ADMIN_PORT` | `3000` | Порт адмін-панелі |
| `ADMIN_TOKEN` | -- | Токен авторизації (для standalone режиму) |
| `ADMIN_HOST` | -- | Публічний URL (наприклад `https://admin.example.com`) |

### Пам'ять

| Змінна | За замовчуванням | Опис |
|--------|-----------------|------|
| `NIGHT_OWL_HOUR` | `4` | Година "переходу дня" (для нічних сов) |
| `USER_PREVIEW_LEN` | `200` | Довжина preview в щоденному логу |
| `ASSISTANT_PREVIEW_LEN` | `300` | Довжина preview відповіді |
| `MIN_MSG_LEN_TO_SAVE` | `20` | Мін. довжина для запису в пам'ять |
| `MAX_ASSISTANT_MEMORY_LEN` | `500` | Макс. довжина запису відповіді |

### Agent

| Змінна | За замовчуванням | Опис |
|--------|-----------------|------|
| `AGENT_WATCHDOG_WARN_SECONDS` | `60` | Попередження при неактивності агента |
| `AGENT_WATCHDOG_TIMEOUT_MS` | `600000` | Таймаут агента (10 хв) |

### Інтеграції

| Змінна | Опис |
|--------|------|
| `BITRIX24_WEBHOOK_URL` | Bitrix24 CRM |
| `META_ACCESS_TOKEN` | Meta/Facebook Ads |
| `META_APP_SECRET` | Meta/Facebook Ads |
| `HA_URL` | Home Assistant URL |
| `HA_TOKEN` | Home Assistant токен |

### Email (SMTP)

| Змінна | Опис |
|--------|------|
| `SMTP_HOST` | SMTP сервер (наприклад `smtp.gmail.com`) |
| `SMTP_PORT` | Порт (наприклад `587`) |
| `SMTP_USER` | Логін |
| `SMTP_PASS` | Пароль або App Password |
| `SMTP_FROM` | Відправник (`Name <email>`) |
| `SMTP_SIGNATURE` | Підпис у markdown |

### Публікація файлів

| Змінна | Опис |
|--------|------|
| `PUBLISH_SSH_HOST` | SSH хост для завантаження |
| `PUBLISH_REMOTE_DIR` | Директорія на сервері |
| `PUBLISH_BASE_URL` | Публічний URL |

### Логування

| Змінна | За замовчуванням | Опис |
|--------|-----------------|------|
| `LOG_LEVEL` | `info` | Рівень: debug, info, warn, error |
| `TELEGRAPH_ENABLED` | `true` | Telegraph для довгих повідомлень |

### Crash-нотифікації (кореневий .env)

| Змінна | Опис |
|--------|------|
| `NOTIFY_BOT_TOKEN` | Токен бота для сповіщень |
| `NOTIFY_CHAT_ID` | Chat ID для сповіщень |

## Структура бота

```
bots/<name>/
├── .env                         # Токени та API-ключі
├── CLAUDE.md                    # Інструкції для AI (збирається з workspace-files/)
├── workspace-files/             # Модульні workspace файли
│   ├── IDENTITY.md              # Ім'я, emoji, опис ролі
│   ├── SOUL.md                  # Душа: правила, інструменти, стиль (read-only)
│   ├── ROLE.md                  # Спеціалізація, сценарії (read-only)
│   ├── TOOLS.md                 # Таблиця "коли який інструмент" (read-only)
│   ├── USER.md                  # Профіль користувача (бот оновлює)
│   └── MEMORY.md                # Курована пам'ять (бот оновлює)
├── knowledge/                   # Знання, профілі, diary
│   ├── user-profile.md          # Базовий профіль користувача
│   ├── KEY_EVENTS.md            # Важливі події
│   └── memories/                # Щоденні логи (YYYY-MM-DD.md)
└── store/
    └── botva.db                 # SQLite база (сесії, пам'ять, usage)
```

## Що НЕ в git (потрібно копіювати вручну)

| Шлях | Зміст |
|------|-------|
| `bots/*/` | Конфіги ботів, .env, знання, бази |
| `workspace/` | Згенеровані зображення, презентації |
| `.env` | Кореневий env (crash watchdog) |
| `.mcp.json` | MCP сервери з API токенами |

## MCP-сервери

Збираються автоматично при `./scripts/deploy.sh setup`. Конфігурація:

- Кореневий: `.mcp.json` (спільні MCP-сервери)
- Per-bot: `bots/<name>/.mcp.json` (специфічні для бота)

Вбудовані MCP-сервери в `mcp-servers/`:
- **bitrix24** -- CRM (контакти, ліди, угоди)
- **meta-ads-mcp** -- Meta/Facebook Ads
- **colleague** -- міжботова комунікація (Unix-сокети)
- **manager** -- координація менеджером
- **pubmed** -- PubMed наукові статті

Зовнішні (підключаються через env-змінні):
- **google-workspace** -- Calendar, Gmail, Drive
- **home-assistant** -- розумний дім
- **stagehand** -- AI-браузер
- **playwright-remote** -- headless Chrome
- **miro** -- дошки, діаграми

## Управління

### deploy.sh

```bash
./scripts/deploy.sh setup      # Встановити залежності, зібрати
./scripts/deploy.sh start      # Запустити всі боти
./scripts/deploy.sh stop       # Зупинити всі боти
./scripts/deploy.sh restart    # Перезапустити
./scripts/deploy.sh build      # Перезібрати TypeScript + MCP
./scripts/deploy.sh status     # Показати статус
./scripts/deploy.sh backup     # Створити бекап
./scripts/deploy.sh restore    # Відновити з бекапу
```

### npm scripts

```bash
npm run build       # Зібрати TypeScript
npm start           # Запустити (після збірки)
npm run dev         # Dev-режим (tsx)
npm run admin       # Адмін-панель
npm run new-bot     # Створити бота
npm run delete-bot  # Видалити бота
npm run status      # Статус ботів
npm run typecheck   # Перевірка типів
npm test            # Тести
```

### З Telegram

- `/admin` -- запустити адмін-панель (автостоп через 20 хв)
- `/admin stop` -- зупинити адмін-панель

## Автозапуск

### macOS (launchd)

```bash
./scripts/deploy.sh launchd
```

Створює LaunchAgent, який автоматично запускає ботів при старті системи.

### Linux (systemd)

```bash
# Створити сервіс (виконується при ./scripts/deploy.sh setup на Linux)
sudo systemctl enable botva
sudo systemctl start botva

# Перевірити статус
sudo systemctl status botva
```

## Бекап та відновлення

### Що бекапити

```bash
tar czf botva-backup.tar.gz \
  bots/ \
  workspace/ \
  .mcp.json \
  .env
```

Ці файли НЕ зберігаються в git -- вони містять токени, персональні дані та бази.

### Відновлення

```bash
cd BotVa
tar xzf botva-backup.tar.gz
./scripts/deploy.sh setup
./scripts/deploy.sh start
```

Також доступний бекап через адмін-панель (розділ Backup) з SHA256-верифікацією.

## Міграція на інший сервер

1. На старому сервері: `tar czf botva-backup.tar.gz bots/ workspace/ .mcp.json .env`
2. На новому: клонуй репо, розпакуй бекап
3. `./scripts/deploy.sh setup && ./scripts/deploy.sh start`
