import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { builtinInFlight } from './builtin-inflight.js'

// Wait for in-flight builtin tool calls to finish before a soft interrupt, so
// their results are delivered instead of dying with "Stream closed by consumer"
// when q.interrupt() closes the consumer stream. Bounded so a stuck handler
// can't block the interrupt indefinitely.
const DRAIN_TIMEOUT_MS = 3000
async function drainBuiltinInFlight(timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
  const start = Date.now()
  while (builtinInFlight.count() > 0 && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 50))
  }
}

type QueuedRequest<T> = {
  handler: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

const activeQueries: Map<string, Query> = new Map()
const abortControllers: Map<string, AbortController> = new Map()
const pendingQueues: Map<string, Array<QueuedRequest<unknown>>> = new Map()
const processingFlags: Map<string, boolean> = new Map()
const cancelledChats: Set<string> = new Set()
const interruptedChats: Set<string> = new Set()
const followupMessages: Map<string, string[]> = new Map()
// Task (subagent) ids currently running inside a session's query. Subagents live
// inside the parent query, so a session-wide q.interrupt() would tear them down
// mid-work. We track them per session so addFollowup can skip the interrupt while
// any subagent is in flight (Variant 2 / protect_subagents setting).
const subagentsInFlight: Map<string, Set<string>> = new Map()

export function subagentStarted(sessionKey: string, taskId: string): void {
  let set = subagentsInFlight.get(sessionKey)
  if (!set) {
    set = new Set()
    subagentsInFlight.set(sessionKey, set)
  }
  set.add(taskId)
}

export function subagentFinished(sessionKey: string, taskId: string): void {
  const set = subagentsInFlight.get(sessionKey)
  if (!set) return
  set.delete(taskId)
  if (set.size === 0) subagentsInFlight.delete(sessionKey)
}

export function hasSubagentsInFlight(sessionKey: string): boolean {
  const set = subagentsInFlight.get(sessionKey)
  return !!set && set.size > 0
}

export function createAbortController(sessionKey: string): AbortController {
  const controller = new AbortController()
  abortControllers.set(sessionKey, controller)
  return controller
}

export function setActiveQuery(sessionKey: string, q: Query): void {
  activeQueries.set(sessionKey, q)
}

export function clearActiveQuery(sessionKey: string): void {
  activeQueries.delete(sessionKey)
  abortControllers.delete(sessionKey)
  subagentsInFlight.delete(sessionKey)
}

export function isCancelled(sessionKey: string): boolean {
  return cancelledChats.has(sessionKey)
}

export function isInterrupted(sessionKey: string): boolean {
  return interruptedChats.has(sessionKey)
}

export function clearCancelled(sessionKey: string): void {
  cancelledChats.delete(sessionKey)
  interruptedChats.delete(sessionKey)
}

export function isProcessing(sessionKey: string): boolean {
  return processingFlags.get(sessionKey) === true
}

export async function queueRequest<T>(
  sessionKey: string,
  handler: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request: QueuedRequest<T> = {
      handler,
      resolve: resolve as (value: unknown) => void,
      reject,
    }

    let queue = pendingQueues.get(sessionKey)
    if (!queue) {
      queue = []
      pendingQueues.set(sessionKey, queue)
    }
    queue.push(request as QueuedRequest<unknown>)

    processQueue(sessionKey)
  })
}

async function processQueue(sessionKey: string): Promise<void> {
  if (processingFlags.get(sessionKey)) return

  const queue = pendingQueues.get(sessionKey)
  if (!queue || queue.length === 0) return

  processingFlags.set(sessionKey, true)
  const request = queue.shift()!

  try {
    const result = await request.handler()
    request.resolve(result)
  } catch (error) {
    request.reject(error instanceof Error ? error : new Error(String(error)))
  } finally {
    processingFlags.set(sessionKey, false)
    clearActiveQuery(sessionKey)
    clearCancelled(sessionKey)

    if (queue.length > 0) {
      processQueue(sessionKey)
    }
  }
}

// Hard stop: kills the agent process (like Ctrl+C)
export async function cancelRequest(sessionKey: string): Promise<boolean> {
  const controller = abortControllers.get(sessionKey)

  if (controller) {
    cancelledChats.add(sessionKey)
    controller.abort()
    clearActiveQuery(sessionKey)
    return true
  }

  return false
}

// Result of a soft interrupt. `stillQueued` is the number of async user
// messages that survive the interrupt and WILL still run unless cancelled —
// reported only when the CLI advertises the `interrupt_receipt_v1` capability
// (older CLIs resolve interrupt() to undefined, so stillQueued stays 0).
export interface InterruptResult {
  interrupted: boolean
  stillQueued: number
}

// Soft stop: asks the agent to finish gracefully (like ESC)
export async function interruptRequest(sessionKey: string): Promise<InterruptResult> {
  const q = activeQueries.get(sessionKey)

  if (q) {
    interruptedChats.add(sessionKey)
    // Let slow builtin tool calls (SendMedia, PublishTelegraph, SaveFact) land
    // before we close the stream — otherwise they fail with "Stream closed by
    // consumer" and the model retries already-applied side effects.
    await drainBuiltinInFlight()
    let stillQueued = 0
    try {
      const receipt = await q.interrupt()
      // Feature-detect the interrupt_receipt_v1 shape; guard for older CLIs
      // that resolve to undefined and for a missing/odd still_queued field.
      if (receipt && Array.isArray(receipt.still_queued)) {
        stillQueued = receipt.still_queued.length
      }
    } catch {
      // interrupt() may throw if query already finished
    }
    return { interrupted: true, stillQueued }
  }

  return { interrupted: false, stillQueued: 0 }
}

// Queue a follow-up message and interrupt agent so it picks up the message
// Agent finishes current tool call, then resumes with the follow-up in same session
export async function addFollowup(
  sessionKey: string,
  text: string,
  protectSubagents = false
): Promise<void> {
  let msgs = followupMessages.get(sessionKey)
  if (!msgs) {
    msgs = []
    followupMessages.set(sessionKey, msgs)
  }
  msgs.push(text)

  // Interrupt only on first followup — agent wraps up current step.
  if (msgs.length === 1) {
    // Variant 2: while a subagent is in flight, skip the interrupt — a
    // session-wide q.interrupt() would tear the subagent down and discard its
    // work. The followup stays queued and is picked up at the natural end of the
    // current turn. With no subagent running, interrupt as before for
    // responsiveness (only a cheap top-level tool call is lost).
    if (protectSubagents && hasSubagentsInFlight(sessionKey)) {
      return
    }
    await interruptRequest(sessionKey)
  }
}

export function getAndClearFollowup(sessionKey: string): string | undefined {
  const msgs = followupMessages.get(sessionKey)
  if (!msgs || msgs.length === 0) return undefined
  followupMessages.delete(sessionKey)
  return msgs.join('\n\n')
}

export function clearQueue(sessionKey: string): number {
  const queue = pendingQueues.get(sessionKey)
  if (!queue) return 0

  const count = queue.length
  for (const request of queue) {
    request.reject(new Error('Queue cleared'))
  }
  queue.length = 0
  return count
}
