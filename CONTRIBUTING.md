# Як долучитись до BotVa

## Початок роботи

```bash
# 1. Fork та клонувати
git clone <your-fork-url> BotVa
cd BotVa

# 2. Встановити залежності та зібрати
./scripts/deploy.sh setup

# 3. Запустити в dev-режимі
npm run dev
```

## Структура проекту

```
src/                    # Основний код (TypeScript, strict mode)
├── bot.ts              # Telegram бот
├── agent.ts            # Claude agent з MCP
├── builtin-tools.ts    # Вбудовані інструменти
├── admin/              # Веб адмін-панель (Hono)
└── *.test.ts           # Тести (поруч з кодом)
roles/                  # Шаблони ролей ботів
mcp-servers/            # MCP сервери
scripts/                # Скрипти управління
```

## Тести

Фреймворк: [Vitest](https://vitest.dev/) 4.x. Тести лежать поруч з кодом: `src/foo.ts` -> `src/foo.test.ts`.

```bash
npm test                                  # Всі тести
npx vitest run src/bounded-map.test.ts    # Один файл
npx vitest run --coverage                 # З coverage
npx vitest                                # Watch mode
```

### Правила тестів

- При зміні модуля -- оновити або додати `.test.ts`
- При додаванні нового модуля -- створити `.test.ts` поруч
- Мокати зовнішні залежності (`./config.js`, `./db.js`, `./logger.js`), не реальні сервіси
- Тести не мають містити персональних даних, реальних токенів, шляхів з іменами

## Стиль коду

- TypeScript strict mode
- ES Modules (`.js` extension в імпортах)
- Детальні правила: [CLAUDE.md](CLAUDE.md)

## Як створити нову роль

1. Створи файл в `roles/<slug>.md`
2. Додай маркери `--- IDENTITY ---`, `--- ROLE ---`, `--- TOOLS ---`
3. Заповни плейсхолдери `{{BOT_NAME}}`, `{{BOT_EMOJI}}`
4. Секція TOOLS -- найважливіша: таблиця trigger -> action -> when NOT
5. Перевір чеклист якості в [CLAUDE.md](CLAUDE.md)

## Як додати builtin tool

1. Додай визначення в `src/builtin-tools.ts`
2. Кожен tool має: `name`, `icon`, `category`, `description`, `inputSchema`, `handler`
3. Додай тести
4. Онови документацію: каталог інструментів в [CLAUDE.md](CLAUDE.md), [README.md](README.md)

## Pull Request

1. Створи гілку: `git checkout -b feat/my-feature`
2. Зроби зміни, додай тести
3. Переконайся що тести проходять: `npm test`
4. Перевір типи: `npm run typecheck`
5. Створи PR з описом що змінилось і чому

### Коміт-повідомлення

Формат: `тип: короткий опис`

Типи: `feat`, `fix`, `refactor`, `add`, `docs`, `test`

### Що перевірити перед PR

- [ ] `npm test` проходить
- [ ] `npm run typecheck` без помилок
- [ ] Немає персональних даних, токенів, паролів в коді
- [ ] Документація оновлена (якщо потрібно)

## Повідомлення про баги

Створи issue з описом:
- Що очікувалось
- Що сталось
- Кроки для відтворення
- Логи (без персональних даних та токенів)

## Ліцензія

Додаючи код в BotVa, ви погоджуєтесь що він буде під [MIT ліцензією](LICENSE).
