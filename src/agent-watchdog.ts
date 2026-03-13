import { logger } from './logger.js'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

export interface WatchdogOptions {
  chatId: string
  warnAfterSeconds: number
  logIntervalSeconds: number
  timeoutMs?: number
  onWarning?: (sinceLastMessageMs: number, totalElapsedMs: number) => void
  onTimeout?: () => void
}

export class AgentWatchdog {
  private chatId: string
  private warnAfterMs: number
  private logIntervalMs: number
  private timeoutMs: number
  private onWarning?: (sinceLastMessageMs: number, totalElapsedMs: number) => void
  private onTimeout?: () => void

  private startTime: number = 0
  private lastActivityTime: number = 0
  private intervalId: ReturnType<typeof setInterval> | null = null
  private hasWarned: boolean = false
  private stopped: boolean = false

  constructor(options: WatchdogOptions) {
    this.chatId = options.chatId
    this.warnAfterMs = options.warnAfterSeconds * 1000
    this.logIntervalMs = options.logIntervalSeconds * 1000
    this.timeoutMs = options.timeoutMs || 0
    this.onWarning = options.onWarning
    this.onTimeout = options.onTimeout
  }

  start(): void {
    this.startTime = Date.now()
    this.lastActivityTime = this.startTime
    this.hasWarned = false
    this.stopped = false

    this.intervalId = setInterval(() => {
      if (this.stopped) return
      this.check()
    }, this.logIntervalMs)
  }

  recordActivity(): void {
    this.lastActivityTime = Date.now()
    this.hasWarned = false
  }

  private check(): void {
    const now = Date.now()
    const sinceLastActivity = now - this.lastActivityTime
    const totalElapsed = now - this.startTime

    if (this.timeoutMs > 0 && totalElapsed >= this.timeoutMs) {
      logger.warn({ chatId: this.chatId, elapsed: formatDuration(totalElapsed) }, 'Watchdog timeout')
      this.onTimeout?.()
      this.stop()
      return
    }

    if (sinceLastActivity >= this.warnAfterMs && !this.hasWarned) {
      this.hasWarned = true
      logger.warn({
        chatId: this.chatId,
        sinceLastActivity: formatDuration(sinceLastActivity),
        totalElapsed: formatDuration(totalElapsed)
      }, 'Watchdog: no messages for a while')
      this.onWarning?.(sinceLastActivity, totalElapsed)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  getElapsedMs(): number {
    return Date.now() - this.startTime
  }
}
