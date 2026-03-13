# BotVa

## Git

При значущих правках -- автоматично комітити зміни. Не питати дозволу на коміт.

### Що комітити

**Комітити (код платформи):**
- `src/`, `scripts/`, `roles/` -- код, скрипти, шаблони ролей
- `mcp-servers/` -- MCP сервери (тільки вихідний код, без `build/`, `venv/`, `node_modules/`)
- `.claude/skills/` -- скіли Claude Code
- `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- `CLAUDE.md`, `DEPLOY.md`
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
