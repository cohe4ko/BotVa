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
/**
 * The live run of a session, while its streaming input is open. A follow-up
 * pushed here reaches the model at the next step boundary instead of
 * interrupting the run (see live-input.ts).
 */
export interface LiveRun {
  /** Queue a user message into the running query; false once its input is closed. */
  push(text: string): boolean
}

/** A background task of a live run, as the SDK reports it in background_tasks_changed. */
export interface BackgroundTask {
  taskId: string
  type: string
  description: string
}

const liveRuns: Map<string, LiveRun> = new Map()
const backgroundTasks: Map<string, BackgroundTask[]> = new Map()

export function setLiveRun(sessionKey: string, run: LiveRun): void {
  liveRuns.set(sessionKey, run)
}

export function setBackgroundTasks(sessionKey: string, tasks: BackgroundTask[]): void {
  if (tasks.length > 0) backgroundTasks.set(sessionKey, tasks)
  else backgroundTasks.delete(sessionKey)
}

export function getBackgroundTasks(sessionKey: string): BackgroundTask[] {
  return backgroundTasks.get(sessionKey) ?? []
}

/**
 * Session key for an unattended run made on behalf of a chat.
 *
 * Every map above is keyed by session. A background run (consolidation, a
 * scheduled task) that used the bare chat id would overwrite the owner's live
 * query and abort controller — and clear them when it finished, so /stop would
 * stop the wrong run or none at all. A key of its own keeps them apart.
 */
export function backgroundKey(kind: string, chatId: string | number): string {
  return `bg:${kind}:${chatId}`
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
  liveRuns.delete(sessionKey)
  backgroundTasks.delete(sessionKey)
}

export function isCancelled(sessionKey: string): boolean {
  return cancelledChats.has(sessionKey)
}

export function isInterrupted(sessionKey: string): boolean {
  return interruptedChats.has(sessionKey)
}

/** A stop ends one turn; the turns after it (a background task reporting back) are not stopped. */
export function clearInterrupted(sessionKey: string): void {
  interruptedChats.delete(sessionKey)
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

/**
 * A message the user sent while the agent works.
 *
 * With a live run it goes straight into the running query: the model picks it
 * up at the next step boundary, nothing is interrupted and no work is lost.
 * Otherwise (the run has not started yet, or its input already closed) it is
 * kept, and the handler starts the next run with it once this one ends.
 */
export async function addFollowup(sessionKey: string, text: string): Promise<void> {
  if (liveRuns.get(sessionKey)?.push(text)) return
  let msgs = followupMessages.get(sessionKey)
  if (!msgs) {
    msgs = []
    followupMessages.set(sessionKey, msgs)
  }
  msgs.push(text)
}

/**
 * Ctrl+B: move what runs in the foreground (Bash commands, subagents) into the
 * background, so the turn goes on — and gets to the user's queued message —
 * without waiting. With `toolUseId`, only the task that tool call started.
 * Returns whether anything was moved.
 */
export async function backgroundRequest(sessionKey: string, toolUseId?: string): Promise<boolean> {
  const q = activeQueries.get(sessionKey)
  if (!q) return false
  try {
    return await q.backgroundTasks(toolUseId)
  } catch {
    return false
  }
}

/** Stop one background task of the live run. */
export async function stopBackgroundTask(sessionKey: string, taskId: string): Promise<boolean> {
  const q = activeQueries.get(sessionKey)
  if (!q) return false
  try {
    await q.stopTask(taskId)
    return true
  } catch {
    return false
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
