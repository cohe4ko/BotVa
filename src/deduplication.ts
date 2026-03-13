const processedMessages: Map<number, number> = new Map()
const MESSAGE_TTL = 60000 // 1 minute

let cleanupInterval: ReturnType<typeof setInterval> | null = null

export function isDuplicate(messageId: number): boolean {
  return processedMessages.has(messageId)
}

export function markProcessed(messageId: number): void {
  processedMessages.set(messageId, Date.now())
  ensureCleanupRunning()
}

function ensureCleanupRunning(): void {
  if (cleanupInterval) return

  cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [id, timestamp] of processedMessages) {
      if (now - timestamp > MESSAGE_TTL) {
        processedMessages.delete(id)
      }
    }

    if (processedMessages.size === 0 && cleanupInterval) {
      clearInterval(cleanupInterval)
      cleanupInterval = null
    }
  }, 30000)
}

export function stopDeduplication(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
}
