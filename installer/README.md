# BotVa Installer

Веб-додаток для автоматичного встановлення BotVa на новий сервер.
Ви заповнюєте форму — інсталятор робить все сам.

## Що потрібно перед початком

1. **Сервер (дроплет)** на [DigitalOcean](https://cloud.digitalocean.com/droplets/new)
   - Система: Ubuntu 24.04 (LTS)
   - Розмір: мінімум 1 GB RAM (рекомендовано 2 GB)
   - Регіон: будь-який (ближче до вас — швидше)
   - Після створення ви отримаєте IP адресу та root пароль на email

2. **Домен** для адмін-панелі (наприклад `admin.example.com`)
   - Створіть A-запис у DNS вашого домену, що вказує на IP сервера
   - Наприклад: `admin.example.com → 123.45.67.89`
   - Як це зробити: залежить від вашого реєстратора (Cloudflare, Namecheap тощо)

3. **Telegram бот**
   - Відкрийте [@BotFather](https://t.me/BotFather) в Telegram
   - Надішліть `/newbot`
   - Дайте боту ім'я та username
   - Скопіюйте **токен** (довгий рядок виду `123456789:ABCdef...`)

4. **Chat ID** (ваш Telegram ID)
   - Надішліть `/start` вашому новому боту
   - Відкрийте в браузері: `https://api.telegram.org/bot<ТОКЕН>/getUpdates`
   - Знайдіть `"chat":{"id":123456789}` — це ваш Chat ID

5. **Акаунт Anthropic** (для Claude)
   - Зареєструйтесь на [console.anthropic.com](https://console.anthropic.com)
   - Під час встановлення інсталятор запропонує увійти в акаунт

## Встановлення

### Крок 1: Запустіть інсталятор

```bash
cd installer
npm install
npm start
```

Браузер відкриється автоматично на `http://localhost:3456`.

### Крок 2: Заповніть форму

- **IP адреса** — з листа DigitalOcean
- **Root пароль** — з листа DigitalOcean
- **Домен** — ваш домен для адмін-панелі
- **Bot Token** — від @BotFather
- **Chat ID** — ваш Telegram ID
- **Ім'я бота** — латиницею, без пробілів (наприклад `my-bot`)
- **URL репозиторію** — адреса git-репозиторію BotVa

### Крок 3: Натисніть "Встановити"

Інсталятор автоматично:
- Оновить систему та встановить необхідні пакети
- Налаштує swap, firewall
- Встановить Node.js 22
- Встановить Claude Code CLI (потрібно буде увійти в акаунт Anthropic)
- Склонує та зберуть BotVa
- Налаштує Caddy для HTTPS
- Створить і запустить бота

Весь процес займає 3-7 хвилин.

### Крок 4: Готово!

Після встановлення відкрийте адмін-панель за вашим доменом (наприклад `https://admin.example.com`).

## Що робить інсталятор на сервері

| Крок | Що встановлюється |
|------|-------------------|
| Система | `git`, `curl`, `build-essential`, `python3` |
| Swap | 2 GB swap file (якщо RAM < 2 GB) |
| Firewall | UFW: SSH + HTTP + HTTPS |
| Користувач | `botva` (не root) для запуску сервісів |
| Node.js | v22 LTS через fnm |
| Claude | Claude Code CLI + вхід в акаунт |
| BotVa | Clone, npm install, build |
| MCP | Всі MCP сервери (Bitrix24, Meta Ads тощо) |
| Caddy | Reverse proxy з автоматичним SSL сертифікатом |
| Бот | Конфіг, systemd сервіс, автозапуск |

## FAQ

### Помилка "Authentication failed"
Перевірте root пароль. DigitalOcean надсилає його на email при створенні дроплету.

### Помилка "Connection timeout"
Перевірте IP адресу. Переконайтесь що дроплет створений і працює.

### Caddy не видає сертифікат
A-запис домену повинен вказувати на IP сервера. DNS зміни можуть зайняти до 24 годин (зазвичай 5-10 хвилин).

### Як перезапустити бота після встановлення?
```bash
ssh root@<IP>
su - botva
cd ~/BotVa
./scripts/deploy.sh restart
```

### Як подивитись логи?
```bash
ssh root@<IP>
su - botva
tail -f ~/BotVa/workspace/logs/botva-*.log
```
