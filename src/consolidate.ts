import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { BOT_DIR, BOT_NAME, ALLOWED_CHAT_ID } from './config.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'
import { memoryDate } from './memory.js'

// Support both 'context' (new) and 'knowledge' (legacy) folder names
const CONTEXT_DIR = existsSync(join(BOT_DIR, 'context')) ? 'context' : 'knowledge'
const MEMORIES_DIR = join(BOT_DIR, CONTEXT_DIR, 'memories')
const KEY_EVENTS_PATH = join(BOT_DIR, CONTEXT_DIR, 'KEY_EVENTS.md')
const MIN_SIZE_FOR_CONSOLIDATION = 500

function prevDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() - 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/**
 * Run daily memory consolidation.
 * Should run at ~04:00 — consolidates "yesterday" (the day that just ended).
 */
export async function runDailyConsolidation(
  sendMessage?: (chatId: string, text: string) => Promise<void>
): Promise<void> {
  // "Yesterday" relative to the 04:00 boundary
  const today = memoryDate()
  const targetDate = prevDate(today)
  const targetFile = join(MEMORIES_DIR, `${targetDate}.md`)

  logger.info({ targetDate, targetFile }, 'Starting daily consolidation')

  if (!existsSync(targetFile)) {
    logger.info({ targetDate }, 'No diary file for consolidation, skipping')
    return
  }

  const content = readFileSync(targetFile, 'utf-8')
  if (content.length < MIN_SIZE_FOR_CONSOLIDATION) {
    logger.info({ targetDate, size: content.length }, 'Diary too short, skipping consolidation')
    return
  }

  // Step 1: Consolidate the daily file
  const consolidatePrompt = `Ти — система консолідації пам'яті ${BOT_NAME}.

Прочитай щоденник за ${targetDate}: ${CONTEXT_DIR}/memories/${targetDate}.md

Консолідуй його:
- Видали дублікати, шум, незначні деталі
- Залиш: ключові рішення, задачі (виконані і невиконані), факти, уподобання, емоції, ідеї
- Збережи хронологічний порядок
- Формат: чистий markdown з секціями

Перезапиши файл ${CONTEXT_DIR}/memories/${targetDate}.md консолідованою версією.
На початку файлу залиш заголовок: # ${targetDate} — Консолідовано`

  try {
    const result = await runAgent(consolidatePrompt, undefined, undefined, ALLOWED_CHAT_ID || '0')
    logger.info({ targetDate, result: result.text?.slice(0, 100) }, 'Consolidation step 1 done')
  } catch (err) {
    logger.error({ err, targetDate }, 'Consolidation step 1 failed')
    return
  }

  // Step 2: Update KEY_EVENTS.md
  const keyEventsPrompt = `Ти — система консолідації пам'яті ${BOT_NAME}.

Прочитай консолідований щоденник: ${CONTEXT_DIR}/memories/${targetDate}.md

Якщо були значні події (важливі рішення, зустрічі, досягнення, проблеми, нові ідеї, зміни планів), додай їх в ${CONTEXT_DIR}/KEY_EVENTS.md.

Формат записів:
- ${targetDate}: короткий опис → [деталі](memories/${targetDate}.md)

Правила:
- Не дублюй якщо подія вже є у файлі
- Групуй по категоріях (## Рішення, ## Задачі, ## Ідеї, ## Події, ## Проблеми)
- Якщо файл не існує, створи з заголовком: # Ключові події
- Додавай тільки дійсно значні речі, не кожну дрібницю
- Пиши українською`

  try {
    const result = await runAgent(keyEventsPrompt, undefined, undefined, ALLOWED_CHAT_ID || '0')
    logger.info({ targetDate, result: result.text?.slice(0, 100) }, 'KEY_EVENTS update done')
  } catch (err) {
    logger.error({ err, targetDate }, 'KEY_EVENTS update failed')
  }

  // Notify user
  if (sendMessage && ALLOWED_CHAT_ID) {
    const { chatT } = await import('./bot-i18n.js')
    await sendMessage(ALLOWED_CHAT_ID, chatT(ALLOWED_CHAT_ID)('consolidate.done', { date: targetDate })).catch(() => {})
  }

  logger.info({ targetDate }, 'Daily consolidation complete')
}
