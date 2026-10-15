/**
 * When a conversation is finished enough to be worth analysing.
 *
 * Telegram is a stream of three-word lines. "так, давай" carries nothing
 * without the five lines before it, and analysing message by message is both
 * expensive and meaningless — so the unit of analysis is a conversation, not a
 * message.
 *
 * Pure on purpose: the decision depends only on counts and timestamps, and it
 * is the part that must be right, so it is testable without a database or a
 * model.
 */

/** Silence that ends a conversation. */
export const IDLE_FLUSH_S = 4 * 60

/** A burst long enough to analyse on its own, before it goes cold. */
export const MAX_BUFFERED = 25

/** Ceiling so an all-day conversation is not held hostage to its own liveness. */
export const MAX_AGE_S = 30 * 60

/** Floor between two analyses of the same chat, whatever else is true. */
export const MIN_FLUSH_GAP_S = 60

export type FlushReason = 'idle' | 'full' | 'aged'

export interface BufferState {
  /** Unanalysed messages waiting in this chat. */
  pending: number
  /** Timestamp of the oldest unanalysed message. */
  oldestTs: number
  /** Timestamp of the newest unanalysed message. */
  newestTs: number
  /** When this chat was last analysed, 0 if never. */
  lastFlushTs: number
}

export interface FlushDecision {
  flush: boolean
  reason?: FlushReason
}

export function shouldFlush(s: BufferState, nowS: number): FlushDecision {
  if (s.pending <= 0) return { flush: false }

  // The gap is checked first and applies to every reason: a chat where someone
  // is typing continuously would otherwise be re-analysed every few seconds,
  // each time on almost the same text.
  if (s.lastFlushTs > 0 && nowS - s.lastFlushTs < MIN_FLUSH_GAP_S) return { flush: false }

  if (s.pending >= MAX_BUFFERED) return { flush: true, reason: 'full' }
  if (nowS - s.newestTs >= IDLE_FLUSH_S) return { flush: true, reason: 'idle' }
  if (nowS - s.oldestTs >= MAX_AGE_S) return { flush: true, reason: 'aged' }
  return { flush: false }
}

/**
 * How soon this chat could possibly become due.
 *
 * Lets the runner sleep instead of polling: with nothing pending anywhere there
 * is nothing to wake up for, and with something pending the earliest deadline
 * is arithmetic, not a guess.
 */
export function secondsUntilDue(s: BufferState, nowS: number): number | null {
  if (s.pending <= 0) return null
  // A full buffer is due on its own terms, but the gap still applies — it is
  // the one rule that overrides every reason to flush.
  const reachedAt = s.pending >= MAX_BUFFERED
    ? nowS
    : Math.min(s.newestTs + IDLE_FLUSH_S, s.oldestTs + MAX_AGE_S)
  const gateAt = s.lastFlushTs > 0 ? s.lastFlushTs + MIN_FLUSH_GAP_S : 0
  return Math.max(0, reachedAt - nowS, gateAt - nowS)
}
