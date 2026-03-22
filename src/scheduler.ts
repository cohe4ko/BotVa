import cronParser from 'cron-parser'
import { getDueTasks, advanceTaskNextRun, updateTaskAfterRun, getDueReminders, markReminderSent, markReminderFailed, deleteReminder } from './db.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'
import type { Api } from 'grammy'

type Sender = (chatId: string, text: string) => Promise<void>

let sender: Sender | null = null
let botApi: Api | null = null
let intervalId: ReturnType<typeof setInterval> | null = null
const runningTasks = new Set<string>()

/** Create a minimal Context-like object for createBuiltinMcpServer */
function createSchedulerCtx(api: Api, chatId: number): any {
  return {
    chat: { id: chatId },
    message: undefined,
    api,
    reply: (text: string, opts?: any) => api.sendMessage(chatId, text, opts),
    replyWithChatAction: (action: any) => api.sendChatAction(chatId, action),
    replyWithPhoto: (input: any, opts?: any) => api.sendPhoto(chatId, input, opts),
    replyWithVoice: (input: any, opts?: any) => api.sendVoice(chatId, input, opts),
    replyWithDocument: (input: any, opts?: any) => api.sendDocument(chatId, input, opts),
    replyWithVideo: (input: any, opts?: any) => api.sendVideo(chatId, input, opts),
    replyWithMediaGroup: (media: any) => api.sendMediaGroup(chatId, media),
    replyWithSticker: (sticker: any) => api.sendSticker(chatId, sticker),
    replyWithAnimation: (input: any, opts?: any) => api.sendAnimation(chatId, input, opts),
    replyWithLocation: (lat: number, lon: number) => api.sendLocation(chatId, lat, lon),
    replyWithVenue: (lat: number, lon: number, title: string, addr: string, opts?: any) =>
      api.sendVenue(chatId, lat, lon, title, addr, opts),
  }
}

export function computeNextRun(cronExpression: string): number {
  const interval = cronParser.parseExpression(cronExpression)
  return Math.floor(interval.next().getTime() / 1000)
}

const REMINDER_MAX_ATTEMPTS = 3

async function sendDueReminders(): Promise<void> {
  const reminders = getDueReminders()
  for (const r of reminders) {
    try {
      if (sender) await sender(r.chat_id, `🔔 ${r.text}`)
      markReminderSent(r.id)
      logger.info({ reminderId: r.id }, 'Reminder sent')
    } catch (err) {
      const failCount = markReminderFailed(r.id)
      if (failCount >= REMINDER_MAX_ATTEMPTS) {
        logger.error({ err, reminderId: r.id, attempts: failCount }, 'Reminder exceeded max attempts, deleting')
        deleteReminder(r.id, r.chat_id)
      } else {
        logger.warn({ err, reminderId: r.id, attempts: failCount }, 'Failed to send reminder, will retry')
      }
    }
  }
}

export async function runDueTasks(): Promise<void> {
  // Send one-shot reminders first (lightweight, no agent execution)
  await sendDueReminders()

  const tasks = getDueTasks()
  if (tasks.length === 0) return

  logger.info({ count: tasks.length }, 'Running due tasks')

  for (const task of tasks) {
    if (runningTasks.has(task.id)) {
      logger.info({ taskId: task.id }, 'Task already running, skipping')
      continue
    }
    runningTasks.add(task.id)
    try {
      if (sender) {
        await sender(task.chat_id, `⏰ Виконую заплановану задачу: ${task.prompt.slice(0, 100)}...`)
      }

      // Create builtin MCP server with minimal tools to save context window
      // Full set = 60+ tools (~20K tokens). Scheduler only needs essentials.
      const SCHEDULER_TOOLS = [
        'SearchMemory', 'SaveFact', 'GetCurrentTime',
        'SendMedia', 'TextToSpeech', 'PublishTelegraph',
        'GenerateImage', 'CurrencyRates', 'RunPython',
        'ReadWorkspaceFile',
      ]
      let builtinServer: any = undefined
      if (botApi) {
        try {
          const { createBuiltinMcpServer } = await import('./builtin-tools.js')
          const ctx = createSchedulerCtx(botApi, Number(task.chat_id))
          const builtin = await createBuiltinMcpServer(ctx, Number(task.chat_id), undefined, SCHEDULER_TOOLS)
          builtinServer = builtin?.server
        } catch (err) {
          logger.warn({ err, taskId: task.id }, 'Failed to create builtin MCP for scheduled task, running without')
        }
      }

      // Advance next_run BEFORE execution — prevents re-run if server crashes mid-task
      const nextRun = computeNextRun(task.schedule)
      advanceTaskNextRun(task.id, nextRun)

      // Run agent with no external MCP servers (allowList=[]) to save context window
      const { text } = await runAgent(
        task.prompt, undefined, undefined, task.chat_id,
        undefined, undefined, builtinServer, undefined, undefined, []
      )
      let result = text ?? '(no response)'

      // Retry once on crash
      if (result.includes('{{agent.crash}}')) {
        logger.warn({ taskId: task.id }, 'Scheduled task crashed, retrying once')
        if (sender) {
          await sender(task.chat_id, '⚠️ Задача впала, повторюю...')
        }
        const retry = await runAgent(
          task.prompt, undefined, undefined, task.chat_id,
          undefined, undefined, builtinServer, undefined, undefined, []
        )
        result = retry.text ?? '(no response on retry)'
      }

      if (sender && !result.includes('{{agent.crash}}')) {
        await sender(task.chat_id, `📋 Результат задачі:\n\n${result}`)
      }

      updateTaskAfterRun(task.id, result.slice(0, 5000))

      logger.info({ taskId: task.id, nextRun }, 'Task completed')
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Task execution failed')
      if (sender) {
        await sender(task.chat_id, `Задача не виконана: ${err instanceof Error ? err.message : String(err)}`)
      }
      // next_run already advanced — just save error result
      updateTaskAfterRun(task.id, `ERROR: ${err}`)
    } finally {
      runningTasks.delete(task.id)
    }
  }
}

export function initScheduler(send: Sender, api?: Api): void {
  sender = send
  botApi = api ?? null
  intervalId = setInterval(runDueTasks, 60_000)
  logger.info('Scheduler started (60s poll interval)')
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
