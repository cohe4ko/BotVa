/**
 * Stall detection for the observer daemon.
 *
 * Kept apart from daemon.ts because that file is an entrypoint — it runs on
 * import — while the decision itself is a pure function of three facts and
 * deserves to be readable and testable on its own.
 *
 * The rule it encodes: a heartbeat that only proves the process exists is not
 * a health check. What matters is whether updates still arrive, and when they
 * stop, whether the connection answers at all.
 */

export type WatchdogAction =
  /** Updates are flowing. Nothing to do. */
  | 'healthy'
  /** No updates, but the connection answered — the account is simply quiet. */
  | 'quiet'
  /** The connection did not answer. Try to bring it back in place. */
  | 'reconnect'
  /** It has not answered often enough. Exit non-zero and let the supervisor act. */
  | 'restart'

export interface WatchdogInput {
  /** Did the raw update counter move since the previous tick? */
  moved: boolean
  /**
   * Did a direct probe of the connection succeed? Only meaningful when the
   * counter stood still — there is no reason to spend a call otherwise.
   */
  alive: boolean
  /** Failed probes so far, including this one. */
  failedProbes: number
  /** Consecutive failures tolerated before giving up. */
  exitsAfter: number
}

export function watchdogAction(i: WatchdogInput): WatchdogAction {
  if (i.moved) return 'healthy'
  if (i.alive) return 'quiet'
  return i.failedProbes >= i.exitsAfter ? 'restart' : 'reconnect'
}

/** Failure streak after a tick, so a recovered connection starts clean. */
export function nextFailureCount(current: number, action: WatchdogAction): number {
  return action === 'healthy' || action === 'quiet' ? 0 : current
}
