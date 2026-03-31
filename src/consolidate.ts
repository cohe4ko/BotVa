import { existsSync, readFileSync, readdirSync, renameSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { BOT_DIR, BOT_NAME, ALLOWED_CHAT_ID } from './config.js'
import { runAgent } from './agent.js'
import { createConsolidationMcpServer } from './builtin-tools.js'
import { logger } from './logger.js'
import { memoryDate } from './memory.js'
import { enqueue, dequeueAll, markDone, markFailed } from './consolidation-queue.js'

const KNOWLEDGE_DIR = 'knowledge'
const MEMORIES_DIR = join(BOT_DIR, KNOWLEDGE_DIR, 'memories')
const KEY_EVENTS_PATH = join(BOT_DIR, KNOWLEDGE_DIR, 'KEY_EVENTS.md')
const MIN_SIZE_FOR_CONSOLIDATION = 500
const MAX_QUEUE_ITEMS_PER_RUN = 7

/**
 * Shared consolidation rules for all fact-saving prompts.
 * DRY: used by daily, weekly, session, and mid-session consolidation.
 * Includes GOOD/BAD examples (claude-mem pattern) for consistent quality.
 */
function buildConsolidationRules(): string {
  return `### Правила збереження фактів

**Перед збереженням:**
1. SearchMemory по ключових словах — перевір чи немає семантично схожого факту
   (точні дублікати відсікаються автоматично хешем, шукай лише смислові збіги)
2. Якщо факт ЗМІНИВСЯ — DeleteFact(old) + SaveFact(new)
3. Тест: "Чи буде це корисно через 3 місяці?" — якщо ні, не зберігай
4. sector=preference ТІЛЬКИ для інструкцій ("завжди", "ніколи", "люблю", "не люблю")
5. Формат preference — ІНСТРУКЦІЯ боту: "Каву без цукру" (не "Любить каву без цукру")
6. Кожен факт — 1-2 речення MAX. Конкретно, без займенників. Стоїть сам без контексту.
7. Tags — якомога більше: синоніми, переклади, пов'язані слова (покращує пошук)

**ДОБРІ факти (конкретні, корисні через 3 місяці):**
- "Алергія на пеніцилін, підтверджена алергологом" [health, semantic, 0.9]
- "Каву без цукру, з вівсяним молоком" [preferences, preference, 0.7]
- "Вирішив продати квартиру на Подолі, ріелтор — Марина" [finance, semantic, 0.8]
- "День народження мами 15 березня" [family, semantic, 0.6]
- "Перейшов на Cursor замість VS Code для TypeScript" [tech, preference, 0.5]

**ПОГАНІ факти (НЕ зберігай):**
- "Обговорювали тему здоров'я" ← абстрактно, нічого конкретного
- "Завантажив фільм Dune 2" ← одноразова дія
- "Файл config.ts має 200 рядків" ← file inventory
- "Курс долара 41.5 грн" ← тимчасове, гуглиться
- "Claude API коштує $3/1M input tokens" ← загальновідоме
- "Chunk 3 завершено, PID 12345" ← прогрес задачі
- "Було повітряне тривога о 14:00" ← новини дня

**Очікуваний результат: 0-3 факти. Якщо більше 5 — зберігаєш забагато.**

Пиши українською.`
}

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function prevDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() - 1)
  return formatDate(d)
}

/** Get ISO week number and year for a date */
function getWeekId(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  // Shift to Thursday of the same week (ISO week convention)
  const day = d.getDay() || 7
  d.setDate(d.getDate() + 4 - day)
  const yearStart = new Date(d.getFullYear(), 0, 1)
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

/** Get Monday of the previous week */
function getPreviousWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const day = d.getDay() || 7 // 1=Mon...7=Sun
  // Go to Monday of current week, then subtract 7
  d.setDate(d.getDate() - day + 1 - 7)
  return formatDate(d)
}

/**
 * Run daily memory consolidation with queue-based retry.
 */
export async function runDailyConsolidation(
  sendMessage?: (chatId: string, text: string) => Promise<void>
): Promise<void> {
  const today = memoryDate()
  const targetDate = prevDate(today)
  const targetFile = join(MEMORIES_DIR, `${targetDate}.md`)

  logger.info({ targetDate }, 'Starting daily consolidation')

  // Enqueue daily if diary file exists
  if (existsSync(targetFile)) {
    enqueue(targetDate, 'daily')
  } else {
    logger.info({ targetDate }, 'No diary file for consolidation, skipping')
  }

  // If Monday — enqueue weekly for previous week
  const now = new Date()
  if (now.getDay() === 1) {
    const weekMonday = getPreviousWeekMonday(today)
    enqueue(weekMonday, 'weekly')
  }

  // Migrate KEY_EVENTS.md (one-time)
  await migrateKeyEvents()

  // Process queue
  await processQueue(sendMessage)

  logger.info('Daily consolidation cycle complete')
}

async function processQueue(
  sendMessage?: (chatId: string, text: string) => Promise<void>
): Promise<void> {
  const items = dequeueAll()

  for (let i = 0; i < Math.min(items.length, MAX_QUEUE_ITEMS_PER_RUN); i++) {
    const item = items[i]

    logger.info({ item }, 'Processing consolidation queue item')

    try {
      if (item.type === 'daily') {
        await consolidateDay(item.targetDate)
      } else {
        await consolidateWeek(item.targetDate)
      }
      markDone(item.targetDate, item.type)

      // Notify user on daily consolidation
      if (item.type === 'daily' && sendMessage && ALLOWED_CHAT_ID) {
        const { chatT } = await import('./bot-i18n.js')
        await sendMessage(ALLOWED_CHAT_ID, chatT(ALLOWED_CHAT_ID)('consolidate.done', { date: item.targetDate })).catch(() => {})
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err, targetDate: item.targetDate, type: item.type }, 'Consolidation failed')
      markFailed(item.targetDate, item.type, msg)
    }
  }
}

/**
 * Single-agent daily consolidation: consolidate diary + save facts.
 */
async function consolidateDay(targetDate: string): Promise<void> {
  const targetFile = join(MEMORIES_DIR, `${targetDate}.md`)

  if (!existsSync(targetFile)) {
    logger.info({ targetDate }, 'Diary file missing, skipping')
    return
  }

  const content = readFileSync(targetFile, 'utf-8')
  const isLong = content.length >= MIN_SIZE_FOR_CONSOLIDATION

  const consolidateStep = isLong
    ? `### 2. Консолідуй щоденник
- Видали дублікати, шум, незначні деталі
- Залиш: ключові рішення, задачі, факти, уподобання, емоції, ідеї
- Перезапиши файл ${KNOWLEDGE_DIR}/memories/${targetDate}.md
- Заголовок: # ${targetDate} — Консолідовано`
    : `### 2. Щоденник короткий — НЕ переписуй файл, але виконай крок 3.`

  const prompt = `Ти — система консолідації пам'яті ${BOT_NAME}.

## Завдання на ${targetDate}

### 1. Прочитай щоденник
Файл: ${KNOWLEDGE_DIR}/memories/${targetDate}.md

${consolidateStep}

### 3. Збережи важливі факти (дуже вибірково!)

${buildConsolidationRules()}`

  const chatId = ALLOWED_CHAT_ID || '0'
  const { server } = createConsolidationMcpServer(Number(chatId))

  const result = await runAgent(prompt, undefined, undefined, chatId, undefined, undefined, server)
  logger.info({ targetDate, result: result.text?.slice(0, 100) }, 'Daily consolidation done')
}

/**
 * Weekly consolidation: summarize the week + save weekly patterns as facts.
 */
async function consolidateWeek(weekStartDate: string): Promise<void> {
  const weeklyDir = join(BOT_DIR, KNOWLEDGE_DIR, 'memories', 'weekly')
  mkdirSync(weeklyDir, { recursive: true })

  // Collect 7 daily files (Mon-Sun)
  const files: string[] = []
  const d = new Date(weekStartDate + 'T12:00:00')
  const weekEnd = new Date(d)
  weekEnd.setDate(weekEnd.getDate() + 6)

  for (let i = 0; i < 7; i++) {
    const date = formatDate(d)
    const filePath = join(MEMORIES_DIR, `${date}.md`)
    if (existsSync(filePath)) {
      files.push(`${KNOWLEDGE_DIR}/memories/${date}.md`)
    }
    d.setDate(d.getDate() + 1)
  }

  if (files.length === 0) {
    logger.info({ weekStartDate }, 'No daily files for weekly consolidation, skipping')
    return
  }

  const weekId = getWeekId(weekStartDate)
  const weekEndStr = formatDate(weekEnd)

  const prompt = `Ти — система консолідації пам'яті ${BOT_NAME}.

## Тижнева консолідація ${weekStartDate} — ${weekEndStr}

### 1. Прочитай щоденники за тиждень
Файли:
${files.map(f => `- ${f}`).join('\n')}

### 2. Створи тижневий підсумок
Збережи у ${KNOWLEDGE_DIR}/memories/weekly/${weekId}.md

Структура:
# Тиждень ${weekId} (${weekStartDate} — ${weekEndStr})
## Основні теми
## Ключові рішення
## Досягнення
## Відкриті питання

### 3. Факти — ТІЛЬКИ нові ПАТТЕРНИ (що стало видно при погляді на тиждень цілком)
НЕ дублюй факти збережені при денній консолідації. Тижнева консолідація — для паттернів, а не для пересказу щоденних подій.

${buildConsolidationRules()}`

  const chatId = ALLOWED_CHAT_ID || '0'
  const { server } = createConsolidationMcpServer(Number(chatId))

  const result = await runAgent(prompt, undefined, undefined, chatId, undefined, undefined, server)
  logger.info({ weekId, result: result.text?.slice(0, 100) }, 'Weekly consolidation done')
}

/**
 * One-time migration: read KEY_EVENTS.md, save each entry as a fact, rename file.
 */
async function migrateKeyEvents(): Promise<void> {
  const migratedPath = KEY_EVENTS_PATH + '.migrated'

  if (!existsSync(KEY_EVENTS_PATH) || existsSync(migratedPath)) {
    return
  }

  logger.info('Migrating KEY_EVENTS.md to facts...')

  const chatId = ALLOWED_CHAT_ID || '0'
  const { server } = createConsolidationMcpServer(Number(chatId))

  const prompt = `Ти — система міграції пам'яті ${BOT_NAME}.

Прочитай файл ${KNOWLEDGE_DIR}/KEY_EVENTS.md.
Для кожного запису збережи як факт, якщо він проходить правила нижче.

${buildConsolidationRules()}`

  try {
    await runAgent(prompt, undefined, undefined, chatId, undefined, undefined, server)
    renameSync(KEY_EVENTS_PATH, migratedPath)
    logger.info('KEY_EVENTS.md migrated and renamed to .migrated')
  } catch (err) {
    logger.error({ err }, 'KEY_EVENTS.md migration failed (will retry next run)')
  }
}

// --- Session consolidation ---

const MIN_SESSION_SIZE = 2000 // ~2-3 turns

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text
    }
  }
  return ''
}

/**
 * Extract facts from a completed session (fire-and-forget, non-blocking).
 * Skips small sessions, already-consolidated sessions, and sessions with unchanged size.
 */
export async function consolidateSession(
  oldSessionId: string,
  chatId: string,
  botDir: string
): Promise<void> {
  const { getClaudeProjectDir } = await import('./disk-sessions.js')
  const projectDir = getClaudeProjectDir(botDir)
  const jsonlPath = join(projectDir, `${oldSessionId}.jsonl`)

  if (!existsSync(jsonlPath)) return

  const fileSize = statSync(jsonlPath).size
  if (fileSize < MIN_SESSION_SIZE) return

  const { isSessionConsolidated, markSessionConsolidated } = await import('./db.js')
  if (isSessionConsolidated(oldSessionId, fileSize)) return

  logger.info({ oldSessionId, fileSize }, 'Starting session consolidation')

  // Read and extract conversation
  const content = readFileSync(jsonlPath, 'utf-8')
  const lines = content.split('\n')
  const turns: string[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'user' && entry.message?.content) {
        let text = extractMessageText(entry.message.content)
        // Strip injected memory context
        text = text.replace(/^\[.*?context.*?\][\s\S]*?\n\n/im, '').trim()
        if (text) turns.push(`**User:** ${text.slice(0, 500)}`)
      }
      if (entry.type === 'assistant' && entry.message?.content) {
        const text = extractMessageText(entry.message.content)
        if (text) turns.push(`**Assistant:** ${text.slice(0, 500)}`)
      }
    } catch { /* skip malformed lines */ }
  }

  if (turns.length < 4) { // at least 2 full turns
    markSessionConsolidated(oldSessionId, fileSize)
    return
  }

  // Take last ~4000 chars of conversation
  let transcript = turns.join('\n\n')
  if (transcript.length > 4000) {
    transcript = '...\n\n' + transcript.slice(-4000)
  }

  const today = memoryDate()
  const prompt = `Ти — система консолідації пам'яті ${BOT_NAME}.

## Завдання: обробка завершеної сесії

### Розмова:
${transcript}

### 1. Запиши підсумок сесії в щоденник
Додай (append) у файл ${KNOWLEDGE_DIR}/memories/${today}.md:

## Сесія [час]
**Запит:** Що користувач хотів (1 речення)
**Зроблено:** Що зроблено/змінено (1-3 пункти)
**Відкрите:** Що залишилось (якщо є)

### 2. Збережи важливі факти (якщо є нові)

${buildConsolidationRules()}`

  const { server } = createConsolidationMcpServer(Number(chatId))
  const result = await runAgent(prompt, undefined, undefined, chatId, undefined, undefined, server)

  markSessionConsolidated(oldSessionId, fileSize)
  logger.info({ oldSessionId, result: result.text?.slice(0, 100) }, 'Session consolidation done')
}

// --- Mid-session fact extraction (proactive, before context overflow) ---

const MIN_NEW_CONTENT = 2000 // minimum new bytes since last extraction

/**
 * Extract facts from an active session when context usage is high.
 * Reads only new content since last extraction to avoid re-processing.
 * Fire-and-forget, non-blocking.
 */
export async function extractFactsMidSession(
  sessionId: string,
  chatId: string,
  botDir: string
): Promise<void> {
  const { getClaudeProjectDir } = await import('./disk-sessions.js')
  const projectDir = getClaudeProjectDir(botDir)
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`)

  if (!existsSync(jsonlPath)) return

  const fileSize = statSync(jsonlPath).size
  const { getMidSessionOffset, setMidSessionOffset } = await import('./db.js')
  const lastOffset = getMidSessionOffset(sessionId)

  // Skip if not enough new content
  if (fileSize - lastOffset < MIN_NEW_CONTENT) return

  logger.info({ sessionId, fileSize, lastOffset }, 'Starting mid-session fact extraction')

  // Read full file but extract turns only from new content
  const content = readFileSync(jsonlPath, 'utf-8')
  const newContent = lastOffset > 0 ? content.slice(lastOffset) : content
  const lines = newContent.split('\n')
  const turns: string[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'user' && entry.message?.content) {
        let text = extractMessageText(entry.message.content)
        text = text.replace(/^\[.*?context.*?\][\s\S]*?\n\n/im, '').trim()
        if (text) turns.push(`**User:** ${text.slice(0, 500)}`)
      }
      if (entry.type === 'assistant' && entry.message?.content) {
        const text = extractMessageText(entry.message.content)
        if (text) turns.push(`**Assistant:** ${text.slice(0, 500)}`)
      }
    } catch { /* skip malformed lines */ }
  }

  if (turns.length < 4) {
    setMidSessionOffset(sessionId, fileSize)
    return
  }

  let transcript = turns.join('\n\n')
  if (transcript.length > 4000) {
    transcript = '...\n\n' + transcript.slice(-4000)
  }

  const prompt = `Ти — система консолідації пам'яті ${BOT_NAME}.

## Завдання: витягни факти з АКТИВНОЇ сесії (контекст заповнюється)

Нижче — нещодавня частина розмови. Збережи ТІЛЬКИ важливі факти, які можуть бути втрачені при стисненні контексту.

### Розмова:
${transcript}

${buildConsolidationRules()}`

  const { server } = createConsolidationMcpServer(Number(chatId))
  const result = await runAgent(prompt, undefined, undefined, chatId, undefined, undefined, server)

  setMidSessionOffset(sessionId, fileSize)
  logger.info({ sessionId, result: result.text?.slice(0, 100) }, 'Mid-session fact extraction done')
}
