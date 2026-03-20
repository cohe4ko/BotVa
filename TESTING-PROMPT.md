# BotVa: промпт для покриття тестами

## Контекст

BotVa -- мульти-агентна AI-платформа для Telegram (TypeScript, strict mode).
- 89 файлів в src/, 25K рядків коду
- Тест-фреймворк: vitest (вже в package.json, скрипт `npm test`)
- Конфіг vitest: ПОТРІБНО СТВОРИТИ (vitest.config.ts)
- Поточне покриття: 0%
- Мета: 60%+ coverage на core-модулях

## Інструкції

### 1. Створи vitest.config.ts

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/admin/**', 'src/index.ts'],
    },
  },
})
```

### 2. Пріоритети тестування (від простого до складного)

#### Tier 1: Чисті утиліти (без залежностей) -- ПОЧНИ З ЦИХ

**`src/bounded-map.ts`** (43 рядки) -- BoundedMap клас
- Тест: set/get, eviction при maxSize, delete, has, clear, size
- Тест: оновлення існуючого ключа не збільшує size
- Тест: порядок eviction (FIFO)

**`src/deduplication.ts`** (39 рядків) -- isDuplicate, markProcessed
- Тест: нове повідомлення = не дублікат
- Тест: повторне = дублікат
- Тест: cleanup після TTL (mock timers)
- Тест: stopDeduplication очищує interval

**`src/memory.ts` > memoryDate()** -- night-owl логіка
- Тест: 15:00 = сьогодні
- Тест: 03:59 = вчора (нічна зміна)
- Тест: 04:00 = сьогодні
- Тест: 00:00 = вчора
- Тест: перехід через місяць (31.03 о 03:00 = 30.03)

**`src/model.ts` > getModelLabel()** -- пошук моделі
- Тест: 'opus' -> 'Opus'
- Тест: 'unknown' -> 'unknown' (fallback)
- Mock getChatSetting для getModel/getTemperature

#### Tier 2: Модулі з легким mocking

**`src/auto-react.ts` > shouldReact / pickEmoji** (якщо є exportовані функції)
- Перевірити EMOJI_DESCRIPTORS: всі мають emoji + desc
- Тест: немає дублікатів emoji

**`src/email-template.ts`** -- HTML email generation
- Тест: markdown -> HTML конвертація
- Тест: escape XSS

**`src/telegraph.ts`** -- Telegraph API
- Тест: markdown -> Telegraph nodes конвертація
- Mock fetch для API calls

**`src/disk-sessions.ts`** -- session persistence
- Тест: serializeSession / deserializeSession roundtrip
- Тест: session TTL expiration
- Mock fs operations

**`src/workspace-files.ts`** -- workspace file management
- Тест: read/write workspace file
- Тест: validation (allowed filenames)
- Mock fs

#### Tier 3: Core бізнес-логіка (складніше, але найцінніше)

**`src/db.ts`** -- SQLite operations
- Тест: insertFact / searchFacts / deleteFact roundtrip
- Тест: FTS5 search працює
- Використай in-memory SQLite (:memory:) або temp file

**`src/builtin-tools.ts`** -- 62 builtin tools
- Тест: getBuiltinToolDefs() повертає 62+ записи
- Тест: всі мають name, icon, category, description
- Тест: isToolEnabled / setToolEnabled toggle
- Тест: дефолти (все enabled крім explicit off)

**`src/config.ts`** -- configuration
- Тест: default values
- Тест: env override
- Тест: type coercion

**`src/mcp-config.ts`** -- MCP server configuration
- Тест: buildMcpServers creates correct structure
- Тест: disabled servers excluded

#### Tier 4: Integration tests

**`src/agent.ts`** -- agent orchestration
- Тест: runAgent з mock MCP servers
- Тест: security modes (plan mode blocks writes)
- Тест: tool permission filtering

**`src/bot-manager.ts`** -- multi-bot management
- Тест: bot lifecycle (create, start, stop, delete)
- Тест: concurrent bot isolation

### 3. Структура тестів

```
src/
  bounded-map.ts
  bounded-map.test.ts      <-- поруч з кодом
  deduplication.ts
  deduplication.test.ts
  memory.ts
  memory.test.ts
  ...
```

### 4. Патерни

```ts
// Чистий тест без залежностей
import { describe, it, expect } from 'vitest'
import { BoundedMap } from './bounded-map.js'

describe('BoundedMap', () => {
  it('evicts oldest entry when full', () => {
    const map = new BoundedMap<string, number>(2)
    map.set('a', 1)
    map.set('b', 2)
    map.set('c', 3) // 'a' should be evicted
    expect(map.has('a')).toBe(false)
    expect(map.get('c')).toBe(3)
    expect(map.size).toBe(2)
  })
})
```

```ts
// Тест з mock timers
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('deduplication', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('marks message as duplicate', async () => {
    const { isDuplicate, markProcessed, stopDeduplication } = await import('./deduplication.js')
    markProcessed(123)
    expect(isDuplicate(123)).toBe(true)
    stopDeduplication()
  })
})
```

```ts
// Тест з mock модулів
import { describe, it, expect, vi } from 'vitest'

vi.mock('./db.js', () => ({
  getChatSetting: vi.fn(),
  setChatSetting: vi.fn(),
}))
```

### 5. Що НЕ тестувати (поки що)

- Telegram Bot API calls (потребує grammy mock)
- Admin panel routes (потребує Hono test client)
- Реальні API виклики (Anthropic, Google, Groq)
- index.ts (entry point)
- Файли в src/admin/ (UI, не core)

### 6. Запуск

```bash
# Всі тести
npm test

# Один файл
npx vitest run src/bounded-map.test.ts

# З coverage
npx vitest run --coverage

# Watch mode
npx vitest
```

### 7. Мінімальна ціль

| Файл | Тестів | Пріоритет |
|------|--------|-----------|
| bounded-map.test.ts | 6 | P0 |
| deduplication.test.ts | 4 | P0 |
| memory.test.ts | 5 | P0 |
| model.test.ts | 4 | P0 |
| db.test.ts | 8 | P1 |
| builtin-tools.test.ts | 5 | P1 |
| workspace-files.test.ts | 4 | P1 |
| telegraph.test.ts | 3 | P2 |
| disk-sessions.test.ts | 3 | P2 |
| config.test.ts | 3 | P2 |
| **Разом** | **~45** | |

Це покриє core модулі і дасть 50-60% coverage на найважливішому коді.
