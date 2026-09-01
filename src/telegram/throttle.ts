/**
 * Telegram Observer — request pacing.
 *
 * Every MTProto call the daemon makes goes through here. The account is a real
 * person's, so the traffic has to look like one: serialised, spaced out, with a
 * ceiling on volume and a hard stop when Telegram pushes back.
 *
 * Three guarantees:
 *   1. One request at a time, with a randomised gap — no bursts, no parallel fan-out.
 *   2. A FLOOD_WAIT pauses *every* caller for the full penalty, not just the
 *      unlucky one that hit it.
 *   3. A daily call budget, so a bug in a loop cannot spend the account.
 */

export class FloodWaitError extends Error {
  constructor(public seconds: number) {
    super(`FLOOD_WAIT: Telegram просить зачекати ${seconds} с`)
    this.name = 'FloodWaitError'
  }
}

export class BudgetExhaustedError extends Error {
  constructor(used: number, budget: number) {
    super(`Денний ліміт запитів до Telegram вичерпано (${used}/${budget}). Скидається опівночі.`)
    this.name = 'BudgetExhaustedError'
  }
}

/** Minimum gap between calls. A person does not fire requests back to back. */
const DEFAULT_MIN_INTERVAL_MS = 700
/** Random extra delay, so the traffic has no machine-perfect rhythm. */
const DEFAULT_JITTER_MS = 500

let minIntervalMs = DEFAULT_MIN_INTERVAL_MS
let jitterMs = DEFAULT_JITTER_MS

/**
 * Test seam: shorten (or remove) the pacing delays.
 *
 * Only tests should call this. Production pacing is the whole point of the
 * module, so the defaults are restored by resetThrottle().
 */
export function configureThrottle(opts: { minIntervalMs?: number; jitterMs?: number }): void {
  if (opts.minIntervalMs !== undefined) minIntervalMs = opts.minIntervalMs
  if (opts.jitterMs !== undefined) jitterMs = opts.jitterMs
}
/**
 * Daily ceiling on API calls.
 *
 * Normal operation is far below this: a dialog sync every 15 minutes plus
 * on-demand reads. Hitting it means something is looping, and stopping is
 * cheaper than an account restriction.
 */
const DAILY_CALL_BUDGET = 3000
/** Refuse rather than queue behind a penalty longer than this. */
const MAX_FLOOD_WAIT_S = 300

export interface ThrottleStats {
  calls: number
  floodWaits: number
  budgetDate: string
  floodUntil: number | null
}

let queue: Promise<unknown> = Promise.resolve()
let lastCallAt = 0
let floodUntil = 0
let callsToday = 0
let budgetDate = ''
let floodWaitCount = 0

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const today = (): string => new Date().toISOString().slice(0, 10)

function noteCall(): void {
  const date = today()
  if (date !== budgetDate) {
    budgetDate = date
    callsToday = 0
  }
  callsToday++
}

/** Telegram reports the penalty inside the message; default high if unparseable. */
export function parseFloodWait(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  if (!msg.includes('FLOOD_WAIT') && !msg.includes('FLOOD')) return null
  const match = msg.match(/(\d+)\s*(?:seconds|s\b)/i) ?? msg.match(/FLOOD_WAIT_(\d+)/)
  return match ? Number(match[1]) : 60
}

export function getThrottleStats(): ThrottleStats {
  return {
    calls: callsToday,
    floodWaits: floodWaitCount,
    budgetDate,
    floodUntil: floodUntil > Date.now() ? floodUntil : null,
  }
}

/** Test seam: reset pacing state between cases. */
export function resetThrottle(): void {
  queue = Promise.resolve()
  lastCallAt = 0
  floodUntil = 0
  callsToday = 0
  budgetDate = ''
  floodWaitCount = 0
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS
  jitterMs = DEFAULT_JITTER_MS
}

/**
 * Run one Telegram API call under the shared pace.
 *
 * Serialised through a single promise chain: concurrent callers queue rather
 * than racing. A FLOOD_WAIT is re-thrown after arming the global pause, so the
 * caller can decide whether to skip or retry later — it is never retried
 * silently, which is how a penalty turns into a ban.
 */
export function throttled<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    if (callsToday >= DAILY_CALL_BUDGET && today() === budgetDate) {
      throw new BudgetExhaustedError(callsToday, DAILY_CALL_BUDGET)
    }

    // Someone already hit a penalty: everyone waits it out.
    const floodRemaining = floodUntil - Date.now()
    if (floodRemaining > 0) {
      if (floodRemaining > MAX_FLOOD_WAIT_S * 1000) {
        throw new FloodWaitError(Math.ceil(floodRemaining / 1000))
      }
      await sleep(floodRemaining)
    }

    const since = Date.now() - lastCallAt
    const gap = minIntervalMs + Math.random() * jitterMs
    if (since < gap) await sleep(gap - since)

    lastCallAt = Date.now()
    noteCall()

    try {
      return await fn()
    } catch (err) {
      const wait = parseFloodWait(err)
      if (wait !== null) {
        floodWaitCount++
        floodUntil = Date.now() + wait * 1000
        throw new FloodWaitError(wait)
      }
      throw err
    }
  })

  // Keep the chain alive regardless of this call's outcome.
  queue = run.then(() => undefined, () => undefined)
  return run as Promise<T>
}

/**
 * Human-like delay before sending, scaled to message length.
 *
 * A reply that lands the instant a message arrives is the clearest tell of
 * automation. Roughly 250 characters per minute of "typing", clamped so short
 * notes are not instant and long ones do not stall the agent.
 */
export function typingDelayMs(text: string): number {
  const perChar = 240 // ms per character, ~250 chars/min
  const raw = text.length * perChar
  return Math.min(Math.max(raw, 1500), 12000)
}
