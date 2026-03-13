import type { Query } from '@anthropic-ai/claude-agent-sdk'

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

// Soft stop: asks the agent to finish gracefully (like ESC)
export async function interruptRequest(sessionKey: string): Promise<boolean> {
  const q = activeQueries.get(sessionKey)

  if (q) {
    interruptedChats.add(sessionKey)
    try {
      await q.interrupt()
    } catch {
      // interrupt() may throw if query already finished
    }
    return true
  }

  return false
}

// Queue a follow-up message and interrupt agent so it picks up the message
// Agent finishes current tool call, then resumes with the follow-up in same session
export async function addFollowup(sessionKey: string, text: string): Promise<void> {
  let msgs = followupMessages.get(sessionKey)
  if (!msgs) {
    msgs = []
    followupMessages.set(sessionKey, msgs)
  }
  msgs.push(text)

  // Interrupt only on first followup — agent wraps up current step
  if (msgs.length === 1) {
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
