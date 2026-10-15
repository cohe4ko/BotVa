/**
 * What happens to one extracted item.
 *
 * The main risk of this whole feature is noise: a memory full of half-true
 * facts poisons the proactive injection that makes it worth having, and the
 * owner stops trusting it in the second week. So the decision is explicit,
 * pure, and testable, rather than scattered through the runner.
 */

import type { AnalysisItem, ItemKind } from './analyze-conversation.js'

/** At or above this, an item is written without asking. */
export const AUTO_SAVE = 0.75

/** Below this, an item is not worth a human glance either. */
export const DROP_BELOW = 0.45

export type GateAction =
  /** Write to the bot's memory now. */
  | 'save'
  /** Hold for review in the admin queue. */
  | 'queue'
  /** Keep only in the message log. */
  | 'drop'

export interface GateDecision {
  action: GateAction
  /** Whether a reminder should be created alongside the fact. */
  reminder: boolean
  why: string
}

export type Sector = 'semantic' | 'episodic' | 'preference'

/** Knowledge or history — the distinction the memory search already makes. */
export function sectorFor(kind: ItemKind): Sector {
  switch (kind) {
    case 'facts':
    case 'contacts':
      return 'semantic'
    default:
      return 'episodic'
  }
}

/** Kinds that can become a reminder, given a date. */
const SCHEDULABLE: ItemKind[] = ['commitments_mine', 'commitments_theirs', 'requests', 'dates']

export function gate(item: Pick<AnalysisItem, 'kind' | 'confidence' | 'when_due'>): GateDecision {
  if (item.confidence < DROP_BELOW) {
    return { action: 'drop', reminder: false, why: 'нижче порога' }
  }

  const schedulable = SCHEDULABLE.includes(item.kind)

  if (item.confidence < AUTO_SAVE) {
    return { action: 'queue', reminder: false, why: 'середня впевненість' }
  }

  // A task with no date cannot fire, and inventing one is worse than asking.
  // It still goes to the queue, where a date can be filled in by hand.
  if (schedulable && !item.when_due) {
    return { action: 'queue', reminder: false, why: 'нема дати' }
  }

  return { action: 'save', reminder: schedulable, why: 'висока впевненість' }
}

/** Cosine similarity above which a candidate is the same thing said again. */
export const DUPLICATE_AT = 0.9

/**
 * One conversation says the same thing five times.
 *
 * A duplicate is not dropped — the existing fact is boosted instead, so
 * repetition raises confidence in what is already known rather than filling
 * memory with copies.
 */
export function isDuplicate(similarity: number): boolean {
  return similarity >= DUPLICATE_AT
}
