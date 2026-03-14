import { existsSync, readFileSync, readdirSync, renameSync, mkdirSync } from 'fs'
import { join } from 'path'
import { BOT_DIR, BOT_NAME, ALLOWED_CHAT_ID } from './config.js'
import { runAgent } from './agent.js'
import { createConsolidationMcpServer } from './builtin-tools.js'
import { logger } from './logger.js'
import { memoryDate } from './memory.js'
import { enqueue, dequeue, markDone, markFailed } from './consolidation-queue.js'

// Support both 'context' (new) and 'knowledge' (legacy) folder names
const CONTEXT_DIR = existsSync(join(BOT_DIR, 'context')) ? 'context' : 'knowledge'
const MEMORIES_DIR = join(BOT_DIR, CONTEXT_DIR, 'memories')
const KEY_EVENTS_PATH = join(BOT_DIR, CONTEXT_DIR, 'KEY_EVENTS.md')
const MIN_SIZE_FOR_CONSOLIDATION = 500
const MAX_QUEUE_ITEMS_PER_RUN = 7

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
  for (let i = 0; i < MAX_QUEUE_ITEMS_PER_RUN; i++) {
    const item = dequeue()
    if (!item) break

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
- Перезапиши файл ${CONTEXT_DIR}/memories/${targetDate}.md
- Заголовок: # ${targetDate} — Консолідовано`
    : `### 2. Щоденник короткий — НЕ переписуй файл, але виконай крок 3.`

  const prompt = `Ти — система консолідації пам'яті ${BOT_NAME}.

## Завдання на ${targetDate}

### 1. Прочитай щоденник
Файл: ${CONTEXT_DIR}/memories/${targetDate}.md

${consolidateStep}

### 3. Збережи важливі факти
a) SearchMemory щоб перевірити які факти вже є
b) SaveFact для НОВИХ важливих фактів:
   - Рішення, плани, зміни планів
   - Нові контакти, імена, дати
   - Здоров'я, уподобання, досягнення
   - НЕ зберігай дрібниці та рутину
   - topic, tags (синоніми!), sector (semantic/episodic)
c) Якщо факт вже існує але змінився — DeleteFact старий + SaveFact новий

Пиши українською.`

  const chatId = ALLOWED_CHAT_ID || '0'
  const { server } = createConsolidationMcpServer(Number(chatId))

  const result = await runAgent(prompt, undefined, undefined, chatId, undefined, undefined, undefined, server)
  logger.info({ targetDate, result: result.text?.slice(0, 100) }, 'Daily consolidation done')
}

/**
 * Weekly consolidation: summarize the week + save weekly patterns as facts.
 */
async function consolidateWeek(weekStartDate: string): Promise<void> {
  const weeklyDir = join(BOT_DIR, CONTEXT_DIR, 'memories', 'weekly')
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
      files.push(`${CONTEXT_DIR}/memories/${date}.md`)
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
Збережи у ${CONTEXT_DIR}/memories/weekly/${weekId}.md

Структура:
# Тиждень ${weekId} (${weekStartDate} — ${weekEndStr})
## Основні теми
## Ключові рішення
## Досягнення
## Відкриті питання

### 3. Збережи тижневі паттерни як факти
a) SearchMemory щоб перевірити що вже є
b) SaveFact для найважливіших тижневих паттернів та висновків
c) Якщо факт вже існує але змінився — DeleteFact старий + SaveFact новий

Пиши українською.`

  const chatId = ALLOWED_CHAT_ID || '0'
  const { server } = createConsolidationMcpServer(Number(chatId))

  const result = await runAgent(prompt, undefined, undefined, chatId, undefined, undefined, undefined, server)
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

Прочитай файл ${CONTEXT_DIR}/KEY_EVENTS.md.

Для КОЖНОГО запису:
1. SearchMemory щоб перевірити чи такий факт вже є
2. Якщо немає — SaveFact з відповідним topic, tags (синоніми!), sector (episodic для подій, semantic для рішень/фактів)

Не дублюй існуючі факти. Пиши українською.`

  try {
    await runAgent(prompt, undefined, undefined, chatId, undefined, undefined, undefined, server)
    renameSync(KEY_EVENTS_PATH, migratedPath)
    logger.info('KEY_EVENTS.md migrated and renamed to .migrated')
  } catch (err) {
    logger.error({ err }, 'KEY_EVENTS.md migration failed (will retry next run)')
  }
}
