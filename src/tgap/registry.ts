/**
 * The running TGAP service, if any. Kept apart from runtime.ts so that the
 * builtin tools can look it up without importing the agent and everything
 * behind it.
 */

import type { TgapService } from './service.js'

let current: TgapService | null = null

export function setTgap(s: TgapService | null): void {
  current = s
}

export function getTgap(): TgapService | null {
  return current
}
