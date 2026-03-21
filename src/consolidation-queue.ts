import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

const QUEUE_PATH = join(STORE_DIR, 'consolidation-queue.json')
export const MAX_ATTEMPTS = 3

export interface QueueItem {
  targetDate: string
  type: 'daily' | 'weekly'
  attempts: number
  lastError?: string
  createdAt: number
}

export function loadQueue(): QueueItem[] {
  try {
    if (existsSync(QUEUE_PATH)) {
      return JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'))
    }
  } catch { /* ignore corrupt file */ }
  return []
}

export function saveQueue(items: QueueItem[]): void {
  mkdirSync(STORE_DIR, { recursive: true })
  writeFileSync(QUEUE_PATH, JSON.stringify(items, null, 2) + '\n')
}

export function enqueue(targetDate: string, type: 'daily' | 'weekly'): void {
  const queue = loadQueue()
  const exists = queue.some(q => q.targetDate === targetDate && q.type === type)
  if (exists) return
  queue.push({ targetDate, type, attempts: 0, createdAt: Date.now() })
  saveQueue(queue)
  logger.debug({ targetDate, type }, 'Enqueued consolidation')
}

/** Return all pending items sorted oldest-first (each item appears only once). */
export function dequeueAll(): QueueItem[] {
  const queue = loadQueue()
  queue.sort((a, b) => a.createdAt - b.createdAt)
  return queue
}

export function markDone(targetDate: string, type: 'daily' | 'weekly'): void {
  const queue = loadQueue()
  saveQueue(queue.filter(q => !(q.targetDate === targetDate && q.type === type)))
}

export function markFailed(targetDate: string, type: 'daily' | 'weekly', error: string): void {
  const queue = loadQueue()
  const item = queue.find(q => q.targetDate === targetDate && q.type === type)
  if (!item) return
  item.attempts++
  item.lastError = error
  if (item.attempts >= MAX_ATTEMPTS) {
    logger.warn({ targetDate, type, attempts: item.attempts, error }, 'Consolidation item exceeded max attempts, removing')
    saveQueue(queue.filter(q => !(q.targetDate === targetDate && q.type === type)))
  } else {
    saveQueue(queue)
    logger.info({ targetDate, type, attempts: item.attempts, error }, 'Consolidation item failed, will retry')
  }
}
