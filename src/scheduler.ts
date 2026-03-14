import cronParser from 'cron-parser'
import { getDueTasks, updateTaskAfterRun, getDueReminders, markReminderSent } from './db.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'

type Sender = (chatId: string, text: string) => Promise<void>

let sender: Sender | null = null
let intervalId: ReturnType<typeof setInterval> | null = null

export function computeNextRun(cronExpression: string): number {
  const interval = cronParser.parseExpression(cronExpression)
  return Math.floor(interval.next().getTime() / 1000)
}

async function sendDueReminders(): Promise<void> {
  const reminders = getDueReminders()
  for (const r of reminders) {
    try {
      if (sender) await sender(r.chat_id, `🔔 ${r.text}`)
      markReminderSent(r.id)
      logger.info({ reminderId: r.id }, 'Reminder sent')
    } catch (err) {
      logger.error({ err, reminderId: r.id }, 'Failed to send reminder')
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
    try {
      if (sender) {
        await sender(task.chat_id, `⏰ Виконую заплановану задачу: ${task.prompt.slice(0, 100)}...`)
      }

      const { text } = await runAgent(task.prompt, undefined, undefined, task.chat_id)
      const result = text ?? '(no response)'

      if (sender) {
        await sender(task.chat_id, `📋 Результат задачі:\n\n${result}`)
      }

      const nextRun = computeNextRun(task.schedule)
      updateTaskAfterRun(task.id, result.slice(0, 5000), nextRun)

      logger.info({ taskId: task.id, nextRun }, 'Task completed')
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Task execution failed')
      if (sender) {
        await sender(task.chat_id, `Задача не виконана: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Still compute next run so we don't get stuck
      const nextRun = computeNextRun(task.schedule)
      updateTaskAfterRun(task.id, `ERROR: ${err}`, nextRun)
    }
  }
}

export function initScheduler(send: Sender): void {
  sender = send
  intervalId = setInterval(runDueTasks, 60_000)
  logger.info('Scheduler started (60s poll interval)')
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
