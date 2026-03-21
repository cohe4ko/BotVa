# BotVa Installer

Веб-додаток для автоматичного розгортання BotVa на новому сервері.
Ви заповнюєте форму в браузері — інсталятор підключається до сервера по SSH і робить все сам.

## Як це працює

```
[Браузер]  ←WebSocket→  [Installer Server]  ←SSH→  [Ваш сервер]
   Форма з параметрами      Node.js app         Ubuntu 24.04
   Live-термінал             ssh2 + Hono         (голий дроплет)
```

Інсталятор:
1. Підключається до вашого сервера по SSH (root)
2. Послідовно виконує кроки налаштування
3. Показує прогрес і вивід у реальному часі
4. В кінці — бот працює, адмін-панель доступна

## Що потрібно перед початком

### 1. Сервер

Створіть дроплет на [DigitalOcean](https://cloud.digitalocean.com/droplets/new):
- **Система:** Ubuntu 24.04 (LTS)
- **Розмір:** мінімум 1 GB RAM (рекомендовано 2 GB)
- **Регіон:** будь-який (ближче до вас — швидше)
- **Авторизація:** пароль (не SSH ключ — інсталятор використовує пароль)

Після створення ви отримаєте **IP адресу** та **root пароль** на email.

### 2. Домен (опціонально)

Якщо хочете HTTPS для адмін-панелі:
- Створіть **A-запис** в DNS вашого домену, що вказує на IP сервера
- Наприклад: `admin.example.com → 123.45.67.89`
- Без домену адмін-панель буде доступна по `http://IP:порт`

### 3. Telegram бот

1. Відкрийте [@BotFather](https://t.me/BotFather) в Telegram
2. Надішліть `/newbot`, дайте ім'я та username
3. Скопіюйте **токен** (рядок виду `123456789:ABCdef...`)

### 4. Chat ID

1. Надішліть `/start` вашому новому боту
2. Відкрийте в браузері: `https://api.telegram.org/bot<ТОКЕН>/getUpdates`
3. Знайдіть `"chat":{"id":123456789}` — це ваш Chat ID

### 5. URL репозиторію BotVa

- Публічне репо: `https://github.com/user/BotVa.git`
- Приватне репо: `https://<TOKEN>@github.com/user/BotVa.git` (з Personal Access Token)

## Запуск інсталятора

### Локально

```bash
cd installer
npm install
npm start
```

Браузер відкриється автоматично на `http://localhost:3456`.

### Як hosted-сервіс

Інсталятор розгорнутий на Render і доступний за постійним URL (див. секцію "Деплой").

## Wizard — крок за кроком

### Крок 1: Сервер

| Поле | Опис |
|------|------|
| **IP адреса** | IP вашого дроплету (з листа DigitalOcean) |
| **Root пароль** | Пароль (з листа DigitalOcean) |
| **Домен** | *(опціонально)* Домен для HTTPS, напр. `admin.example.com` |
| **Порт адмінки** | Порт адмін-панелі (за замовчуванням `3000`) |

### Крок 2: Бот і інтеграції

| Поле | Опис |
|------|------|
| **Bot Token** | Токен від @BotFather |
| **Chat ID** | Ваш Telegram user ID |
| **Ім'я бота** | Латиницею, без пробілів — стане назвою папки |
| **URL репозиторію** | Git URL для `git clone` |
| **MCP сервери** | Чекбокси — які інтеграції встановити |

#### Доступні MCP сервери

| MCP | Опис |
|-----|------|
| **Bitrix24** | CRM: контакти, ліди, угоди, компанії |
| **Meta Ads** | Управління рекламою Facebook/Instagram |
| **PubMed** | Пошук наукових статей (медицина) |
| **Colleague** | Зв'язок між ботами через Unix sockets |
| **Manager** | Координація ботів менеджером |

### Крок 3: Встановлення

Натисніть **"Встановити"** — інсталятор виконає всі кроки автоматично.
Прогрес відображається через progress bar і live-термінал (xterm.js).

## Що встановлюється на сервері

| # | Крок | Деталі |
|---|------|--------|
| 1 | Оновлення системи | `apt update && apt upgrade` (чекає якщо apt зайнятий) |
| 2 | Системні пакети | `git`, `curl`, `build-essential`, `python3`, `jq`, `systemd-container` |
| 3 | Swap 2GB | Swap file (якщо ще нема) |
| 4 | Firewall | UFW: SSH + HTTP/HTTPS + порт адмінки |
| 5 | Користувач `botva` | Окремий користувач для запуску сервісів (не root) |
| 6 | Node.js 22 LTS | Через [fnm](https://github.com/Schniz/fnm) |
| 7 | Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |
| 8 | Clone BotVa | `git clone` з вказаного URL |
| 9 | npm install + build | Залежності та компіляція TypeScript |
| 10 | MCP сервери | Тільки обрані у wizard |
| 11 | Caddy + HTTPS | *(тільки якщо вказаний домен)* Reverse proxy з авто-SSL |
| 12 | Створення бота | `.env` з токеном, chat ID, генерація `ADMIN_TOKEN` |
| 13 | Systemd + запуск | Systemd user services, `enable-linger`, запуск бота + адмін-панелі |

Весь процес займає **3-7 хвилин** залежно від швидкості сервера.

## Після встановлення

- **Адмін-панель** відкриється автоматично (посилання з токеном у done-банері)
- **Бот** вже працює і відповідає в Telegram
- **Логи** видно в терміналі інсталятора
- **Лог файл** можна завантажити кнопкою "Завантажити лог"

### Адмін-панель надалі

Адмін-панель працює **on-demand** — не висить постійно:
- Запуск: надішліть `/admin` вашому боту в Telegram
- Автоматично зупиняється через 20 хвилин неактивності
- `ADMIN_TOKEN` зберігається в `~/BotVa/.env`

### Перезапуск бота

```bash
ssh root@<IP>
su - botva
cd ~/BotVa
./scripts/deploy.sh restart
```

### Логи

```bash
ssh root@<IP>
su - botva
tail -f ~/BotVa/workspace/logs/botva-*.log
```

### Systemd

```bash
# Від користувача botva:
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user status botva-*
systemctl --user restart botva-<ім'я>
journalctl --user -u botva-<ім'я> -f
```

## Деплой інсталятора як hosted-сервіс

### Render (безкоштовний)

Найпростіший спосіб — `render.yaml` вже є в корені репо:

1. Push репо на GitHub
2. Відкрийте `https://render.com/deploy?repo=https://github.com/<user>/BotVa`
3. Натисніть Deploy
4. Інсталятор буде доступний за URL типу `https://botva-installer.onrender.com`

Або вручну: New → Web Service → GitHub repo → Root Directory: `installer` → Free tier.

### Railway

```
railway.app → New Project → Deploy from GitHub → Root Directory: installer
```

### Docker

```bash
cd installer
docker build -t botva-installer .
docker run -p 3456:3456 botva-installer
```

### Fly.io

```bash
cd installer
fly launch --no-deploy
fly deploy
```

## Безпека

- Credentials (пароль, токени) передаються тільки через **WebSocket** між браузером і сервером інсталятора
- На сервері інсталятора **нічого не зберігається** — дані тільки в пам'яті під час SSH сесії
- Дані форми зберігаються в **localStorage** браузера (для зручності при повторному запуску)
- Рекомендується використовувати HTTPS (Render/Railway надають автоматично)
- Після встановлення змініть root пароль на сервері

## Технічний стек

| Компонент | Технологія |
|-----------|------------|
| HTTP сервер | [Hono](https://hono.dev) + `@hono/node-server` |
| SSH | [ssh2](https://github.com/mscdex/ssh2) |
| WebSocket | [ws](https://github.com/websockets/ws) |
| Термінал (UI) | [xterm.js](https://xtermjs.org) 5.5 (CDN) |
| Фронтенд | Один HTML файл, inline CSS/JS, zero dependencies |
| i18n | Українська / English (перемикач у header) |

## Структура файлів

```
installer/
├── package.json
├── tsconfig.json
├── Dockerfile
├── .dockerignore
├── README.md
└── src/
    ├── server.ts         # HTTP + WebSocket сервер
    ├── provisioner.ts    # SSH підключення, виконання кроків
    ├── steps.ts          # Масив кроків provisioning
    └── static/
        └── index.html    # Wizard UI (UA/EN)
```

## FAQ

### "Authentication failed"
Перевірте root пароль. DigitalOcean надсилає його на email при створенні дроплету. Переконайтесь що обрали авторизацію по паролю (не SSH ключ).

### "Connection timeout"
Перевірте IP адресу. Переконайтесь що дроплет створений і працює (зелений індикатор в панелі DO).

### "Could not get lock /var/lib/apt"
Свіжий дроплет автоматично запускає оновлення. Інсталятор чекає поки `apt` звільниться — зазвичай 1-2 хвилини.

### Caddy не видає сертифікат
A-запис домену повинен вказувати на IP сервера. DNS зміни можуть зайняти до 24 годин (зазвичай 5-10 хвилин).

### Бот не стартує після reboot
Перевірте що linger увімкнений: `loginctl show-user botva | grep Linger`. Якщо ні — `sudo loginctl enable-linger botva`.

### Можна запустити повторно?
Так. Кроки idempotent — перевіряють чи вже встановлено перед дією (`if command -v node`, `if [ -d ~/BotVa ]` тощо).
