import { resolve } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import cronParser from 'cron-parser'
import { createBackup, deleteBackup, listBackups, getProjectRoot, getBackupsDir } from './engine.js'
import type { ScheduleConfig } from './types.js'

const SCHEDULE_FILE = 'workspace/backup-schedule.json'
let schedulerTimer: ReturnType<typeof setInterval> | null = null

export function getSchedulePath(): string {
  return resolve(getProjectRoot(), SCHEDULE_FILE)
}

export function loadScheduleConfig(): ScheduleConfig | null {
  const path = getSchedulePath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

export function saveScheduleConfig(config: ScheduleConfig): void {
  writeFileSync(getSchedulePath(), JSON.stringify(config, null, 2) + '\n')
}

export function applyRetention(keepCount: number, dir?: string): string[] {
  const backups = listBackups(dir)
  const deleted: string[] = []

  if (backups.length <= keepCount) return deleted

  // Delete oldest backups beyond keepCount
  const toDelete = backups.slice(keepCount)
  for (const backup of toDelete) {
    if (deleteBackup(backup.filename, dir)) {
      deleted.push(backup.filename)
    }
  }
  return deleted
}

function getNextRun(cronExpr: string): Date | null {
  try {
    const interval = cronParser.parseExpression(cronExpr)
    return interval.next().toDate()
  } catch {
    return null
  }
}

let nextRunTime: number | null = null

function checkAndRunBackup(): void {
  const config = loadScheduleConfig()
  if (!config?.enabled) return

  const now = Date.now()

  // Initialize next run time
  if (nextRunTime === null) {
    const next = getNextRun(config.cron)
    if (!next) return
    nextRunTime = next.getTime()
  }

  if (now < nextRunTime) return

  // Time to run backup
  try {
    createBackup({ type: config.type, botName: config.botName })
    applyRetention(config.retentionCount)
  } catch (err) {
    console.error('[backup-scheduler] Backup failed:', err instanceof Error ? err.message : err)
  }

  // Schedule next run
  const next = getNextRun(config.cron)
  nextRunTime = next ? next.getTime() : null
}

export function initBackupScheduler(): void {
  if (schedulerTimer) return

  const config = loadScheduleConfig()
  if (!config?.enabled) return

  // Check every 60 seconds
  schedulerTimer = setInterval(checkAndRunBackup, 60_000)
  // Also check immediately
  checkAndRunBackup()
}

export function stopBackupScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
  nextRunTime = null
}
