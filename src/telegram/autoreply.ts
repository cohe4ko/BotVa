/**
 * Telegram Observer — unattended replies.
 *
 * Decides, cheaply and deterministically, when a bot may answer on the owner's
 * behalf. No model runs here: this module only says "this message has been
 * hanging long enough, and nobody has answered it". Composing and sending the
 * answer belongs to the bot process.
 *
 * The rule is intentionally narrow. A bot speaking as the account holder is the
 * single most damaging thing this system can do wrong, so every condition below
 * is a reason NOT to speak, and all of them must be cleared.
 */

import { listAutoReplyChats, getLastMessage, type TgChat, type TgMessage } from './db.js'

/** Absolute floor on the gap between two replies, whatever the chat is set to. */
export const MIN_REPLY_GAP_S = 30

/**
 * Minimum gap between two unattended replies in the same chat.
 *
 * Without a gap, a burst of incoming messages — each newer than the last
 * answered id — would be answered one after another and read as a machine
 * talking over someone. The gap follows the configured threshold rather than
 * being fixed: a chat set to answer after 30 seconds is a chat the owner wants
 * kept alive, and a ten-minute lockout would defeat that.
 */
export function replyGapFor(chat: TgChat): number {
  return Math.max(MIN_REPLY_GAP_S, chat.auto_reply_after_s)
}

export interface AutoReplyCandidate {
  chat: TgChat
  /** The message that has gone unanswered. */
  trigger: TgMessage
  /** Seconds it has been waiting. */
  waitedS: number
}

/** Why a chat was passed over — surfaced in the log so silence is explainable. */
export type SkipReason =
  | 'no-messages'
  | 'owner-answered'
  | 'already-answered'
  | 'too-soon'
  | 'cooldown'
  | 'read'

export interface AutoReplyDecision {
  chat: TgChat
  candidate: AutoReplyCandidate | null
  skip: SkipReason | null
}

/**
 * Evaluate one chat.
 *
 * `unread` is the caller's best knowledge of the Telegram-side unread state; the
 * stored counter is a fallback for when no fresh value is available.
 */
export function evaluateChat(chat: TgChat, nowS: number, unread?: number): AutoReplyDecision {
  const last = getLastMessage(chat.chat_id)
  if (!last) return { chat, candidate: null, skip: 'no-messages' }

  // The owner spoke last — there is nothing unanswered.
  if (last.direction !== 'in') return { chat, candidate: null, skip: 'owner-answered' }

  if (last.msg_id <= chat.auto_reply_last_msg_id) {
    return { chat, candidate: null, skip: 'already-answered' }
  }

  // Measured from the NEWEST incoming message, so a burst restarts the clock.
  // Someone typing three lines in a row is still mid-thought; answering after
  // the first would cut them off, and answering each in turn would be three
  // replies to one thought. The whole burst is then answered once, because the
  // context handed to the agent carries all of it.
  const waitedS = nowS - last.ts
  if (waitedS < chat.auto_reply_after_s) return { chat, candidate: null, skip: 'too-soon' }

  if (chat.auto_reply_last_ts !== null && nowS - chat.auto_reply_last_ts < replyGapFor(chat)) {
    return { chat, candidate: null, skip: 'cooldown' }
  }

  if (chat.auto_reply_require_unread) {
    const effective = unread ?? chat.unread
    // The owner has opened the chat: they have seen it and chosen not to reply
    // yet. That is a decision, not an absence, and it is not ours to override.
    if (effective <= 0) return { chat, candidate: null, skip: 'read' }
  }

  return { chat, candidate: { chat, trigger: last, waitedS }, skip: null }
}

/**
 * Chats this bot may answer right now.
 *
 * `unreadFor` lets the caller supply a live unread count per chat — the stored
 * counter is only refreshed periodically, and acting on a stale one would mean
 * answering a message the owner has already read.
 */
export function findAutoReplyCandidates(
  bot: string,
  nowS: number,
  unreadFor?: (chatId: string) => number | undefined,
): AutoReplyDecision[] {
  return listAutoReplyChats(bot).map(chat => evaluateChat(chat, nowS, unreadFor?.(chat.chat_id)))
}
