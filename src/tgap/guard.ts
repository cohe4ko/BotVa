/**
 * TGAP loop prevention (spec §7) — everything that must be decided before a
 * peer's message is allowed anywhere near the model.
 *
 * Telegram requires these safeguards for bot-to-bot traffic; a bot that skips
 * them can be flooded into a loop and restricted by the platform.
 */

import type { Envelope, ErrorCode } from './envelope.js'
import { ELICITING } from './envelope.js'

export const DEFAULT_MAX_TURNS = 6
export const HARD_MAX_TURNS = 20
export const MAX_HOP = 3
export const OUT_GAP_MS = 3000
export const IN_REQUESTS_PER_HOUR = 20
export const ERROR_GAP_MS = 60_000

export type Verdict =
  | { action: 'process' }
  /** Handle it, but never answer it automatically (non-eliciting type). */
  | { action: 'absorb' }
  /** Ignore silently: duplicate, stale turn, or over a limit we already reported. */
  | { action: 'drop'; reason: string }
  /** Reply with a protocol error, then stop. */
  | { action: 'error'; code: ErrorCode; reason: string }

export interface ConvState { max_turns: number; last_turn: number }

/** Effective turn ceiling for a conversation. */
export function turnCeiling(requested?: number): number {
  const n = Number.isInteger(requested) && (requested as number) > 0 ? (requested as number) : DEFAULT_MAX_TURNS
  return Math.min(n, HARD_MAX_TURNS)
}

/**
 * Decide what to do with a well-formed, not-yet-seen envelope.
 *
 * `conv` is the known conversation state, or undefined for a conversation we
 * have never seen. `recentRequests` is how many requests this peer sent in the
 * last hour.
 */
export function judge(env: Envelope, conv: ConvState | undefined, recentRequests: number): Verdict {
  if (!ELICITING.has(env.type)) return { action: 'absorb' }
  if (env.type === 'hello') return { action: 'process' }

  // request
  if ((env.hop ?? 0) > MAX_HOP) return { action: 'error', code: 'hop_limit', reason: `hop ${env.hop} exceeds ${MAX_HOP}` }
  if (recentRequests >= IN_REQUESTS_PER_HOUR) return { action: 'error', code: 'rate_limited', reason: 'too many requests this hour' }

  const turn = env.turn ?? 1
  const ceiling = conv ? conv.max_turns : turnCeiling(env.body?.max_turns)
  if (turn > ceiling) return { action: 'error', code: 'turn_limit', reason: `turn ${turn} exceeds ${ceiling}` }
  // A turn we have already passed is a replay or a reorder: ignore it. A gap is
  // fine — messages can be lost (§7.2).
  if (conv && turn <= conv.last_turn) return { action: 'drop', reason: `stale turn ${turn} <= ${conv.last_turn}` }
  return { action: 'process' }
}

/**
 * Per-peer pacing for what we send: at most one message every OUT_GAP_MS, and
 * at most one error per ERROR_GAP_MS (further errors are dropped). In memory —
 * a restart forgets it, which only makes us a little more talkative once.
 */
export class Pacer {
  private lastOut = new Map<number, number>()
  private lastError = new Map<number, number>()

  constructor(private clock: () => number = Date.now) {}

  /** Milliseconds to wait before the next message to this peer may go out. */
  waitMs(peerId: number): number {
    const last = this.lastOut.get(peerId)
    if (last === undefined) return 0
    return Math.max(0, last + OUT_GAP_MS - this.clock())
  }

  sent(peerId: number): void {
    this.lastOut.set(peerId, this.clock())
  }

  /** Whether an error may be sent to this peer now; records it if so. */
  allowError(peerId: number): boolean {
    const t = this.clock()
    const last = this.lastError.get(peerId)
    if (last !== undefined && t - last < ERROR_GAP_MS) return false
    this.lastError.set(peerId, t)
    return true
  }
}
