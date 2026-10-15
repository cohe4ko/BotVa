/**
 * Which chat a streaming draft belongs to.
 *
 * Telegram's stop button on a draft (Bot API 10.3, `can_stop`) comes back as a
 * `stopped_message_generation` update carrying only the chat and the draft id.
 * Drafts register here while they stream, so the update can be traced to the
 * run that produced it — and a stale or foreign draft id stops nothing.
 */

const drafts = new Map<number, string>()

export function registerDraft(draftId: number, chatId: string): void {
  drafts.set(draftId, chatId)
}

export function unregisterDraft(draftId: number): void {
  drafts.delete(draftId)
}

/** The chat whose run should stop, or null if the draft is unknown or not from that chat. */
export function chatForStoppedDraft(draftId: number, chatId: string): string | null {
  const owner = drafts.get(draftId)
  return owner !== undefined && owner === chatId ? owner : null
}
