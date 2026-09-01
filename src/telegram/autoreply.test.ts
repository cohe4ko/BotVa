import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'

const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-tg-ar-'))
})

vi.mock('./paths.js', () => ({
  PROJECT_ROOT: testDir,
  TG_STORE_DIR: testDir,
  TG_DB_PATH: join(testDir, 'telegram.db'),
  TG_SESSION_PATH: join(testDir, 'telegram.session'),
  TG_SOCK_PATH: join(testDir, 'telegram.sock'),
  TG_PID_PATH: join(testDir, 'telegram.pid'),
  TG_LOG_PATH: join(testDir, 'telegram-observer.log'),
  TG_MEDIA_DIR: join(testDir, 'media'),
}))

import {
  getTgDb, closeTgDb, upsertChat, insertMessage, setAutoReply, markAutoReplied,
  listAutoReplyChats, getChat, setChatUnread, setOwnerId, resetOwnerCache,
  setAutoReplyPrompt, getOwnerStyleSamples,
} from './db.js'
import { findAutoReplyCandidates, evaluateChat, replyGapFor } from './autoreply.js'

const NOW = 1_700_000_000

function reset(): void {
  const d = getTgDb()
  d.exec('DELETE FROM tg_messages')
  d.exec('DELETE FROM tg_messages_fts')
  d.exec('DELETE FROM tg_chats')
  d.exec('DELETE FROM tg_cursor')
  d.exec("DELETE FROM tg_meta WHERE key = 'owner_id'")
  resetOwnerCache()
  setOwnerId('owner-1')
}

/** A chat assigned to `cap`, with one unanswered incoming message N seconds old. */
function chatWaiting(secondsAgo: number, opts: { requireUnread?: boolean; unread?: number } = {}) {
  upsertChat({ chat_id: '111', title: 'Оля', kind: 'user', defaultMode: 'log-only' })
  insertMessage({ chat_id: '111', msg_id: 10, direction: 'in', text: 'привіт, є хвилинка?', ts: NOW - secondsAgo })
  setAutoReply('111', { bot: 'cap', afterSeconds: 300, requireUnread: opts.requireUnread ?? false })
  // setAutoReply marks everything already logged as answered — the message that
  // should trigger arrives after the policy is switched on.
  insertMessage({ chat_id: '111', msg_id: 11, direction: 'in', text: 'то як?', ts: NOW - secondsAgo })
  setChatUnread('111', opts.unread ?? 1)
  return getChat('111')!
}

beforeEach(reset)

afterAll(() => {
  closeTgDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('auto-reply policy', () => {
  it('answers a message left hanging past the threshold', () => {
    const chat = chatWaiting(600)
    const d = evaluateChat(chat, NOW)
    expect(d.skip).toBeNull()
    expect(d.candidate!.trigger.msg_id).toBe(11)
    expect(d.candidate!.waitedS).toBe(600)
  })

  it('stays silent before the threshold', () => {
    const chat = chatWaiting(120)
    expect(evaluateChat(chat, NOW).skip).toBe('too-soon')
  })

  it('stays silent when the owner has already answered', () => {
    const chat = chatWaiting(600)
    insertMessage({ chat_id: '111', msg_id: 12, direction: 'out', text: 'зараз відпишу', ts: NOW - 60 })
    expect(evaluateChat(getChat('111')!, NOW).skip).toBe('owner-answered')
    expect(chat.chat_id).toBe('111')
  })

  it('never answers the same message twice', () => {
    chatWaiting(600)
    markAutoReplied('111', 11, NOW - 60)
    expect(evaluateChat(getChat('111')!, NOW).skip).toBe('already-answered')
  })

  it('holds a cooldown between replies even when a newer message arrives', () => {
    chatWaiting(600)
    markAutoReplied('111', 11, NOW - 60)
    insertMessage({ chat_id: '111', msg_id: 12, direction: 'in', text: 'ще одне', ts: NOW - 400 })
    expect(evaluateChat(getChat('111')!, NOW).skip).toBe('cooldown')

    markAutoReplied('111', 11, NOW - replyGapFor(getChat('111')!) - 1)
    expect(evaluateChat(getChat('111')!, NOW).skip).toBeNull()
  })

  it('respects a read chat when the policy requires unread', () => {
    chatWaiting(600, { requireUnread: true, unread: 0 })
    expect(evaluateChat(getChat('111')!, NOW).skip).toBe('read')
  })

  it('ignores read state when the policy does not require unread', () => {
    chatWaiting(600, { requireUnread: false, unread: 0 })
    expect(evaluateChat(getChat('111')!, NOW).skip).toBeNull()
  })

  it('prefers a live unread count over the stored one', () => {
    chatWaiting(600, { requireUnread: true, unread: 3 })
    // Stored counter says unread, but Telegram says the owner has opened it.
    expect(evaluateChat(getChat('111')!, NOW, 0).skip).toBe('read')
  })

  it('switching the policy on does not answer an old conversation', () => {
    upsertChat({ chat_id: '222', title: 'Давня розмова', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '222', msg_id: 5, direction: 'in', text: 'ще з минулого тижня', ts: NOW - 7 * 86400 })
    setAutoReply('222', { bot: 'cap', afterSeconds: 300, requireUnread: false })
    expect(evaluateChat(getChat('222')!, NOW).skip).toBe('already-answered')
  })

  it('routes each chat to its own bot and nobody else', () => {
    chatWaiting(600)
    upsertChat({ chat_id: '333', title: 'Інший', kind: 'user', defaultMode: 'log-only' })
    setAutoReply('333', { bot: 'doc', afterSeconds: 300, requireUnread: false })
    insertMessage({ chat_id: '333', msg_id: 1, direction: 'in', text: 'алло', ts: NOW - 600 })

    expect(listAutoReplyChats('cap').map(c => c.chat_id)).toEqual(['111'])
    expect(findAutoReplyCandidates('doc', NOW).filter(d => d.candidate).map(d => d.chat.chat_id)).toEqual(['333'])
    expect(findAutoReplyCandidates('asker', NOW)).toEqual([])
  })

  it('clearing the policy removes the chat from every bot', () => {
    chatWaiting(600)
    setAutoReply('111', { bot: '', afterSeconds: 300, requireUnread: false })
    expect(listAutoReplyChats('cap')).toEqual([])
  })

  it('never lets the threshold drop below half a minute', () => {
    chatWaiting(600)
    setAutoReply('111', { bot: 'cap', afterSeconds: 0, requireUnread: false })
    expect(getChat('111')!.auto_reply_after_s).toBe(30)
  })

  it('does not see chats belonging to another account', () => {
    chatWaiting(600)
    setOwnerId('owner-2')
    expect(listAutoReplyChats('cap')).toEqual([])
  })
})

describe('bursts and fast reaction', () => {
  it('waits from the newest message, so a burst does not get cut off', () => {
    upsertChat({ chat_id: '111', title: 'Оля', kind: 'user', defaultMode: 'log-only' })
    setAutoReply('111', { bot: 'cap', afterSeconds: 300, requireUnread: false })

    // Three lines in a row; the last one is still fresh.
    insertMessage({ chat_id: '111', msg_id: 20, direction: 'in', text: 'слухай', ts: NOW - 900 })
    insertMessage({ chat_id: '111', msg_id: 21, direction: 'in', text: 'там питання', ts: NOW - 700 })
    insertMessage({ chat_id: '111', msg_id: 22, direction: 'in', text: 'коли зможеш?', ts: NOW - 60 })
    expect(evaluateChat(getChat('111')!, NOW).skip).toBe('too-soon')
  })

  it('answers the whole burst once, at the newest message', () => {
    upsertChat({ chat_id: '111', title: 'Оля', kind: 'user', defaultMode: 'log-only' })
    setAutoReply('111', { bot: 'cap', afterSeconds: 300, requireUnread: false })
    insertMessage({ chat_id: '111', msg_id: 20, direction: 'in', text: 'слухай', ts: NOW - 900 })
    insertMessage({ chat_id: '111', msg_id: 21, direction: 'in', text: 'коли зможеш?', ts: NOW - 600 })

    const d = evaluateChat(getChat('111')!, NOW)
    expect(d.candidate!.trigger.msg_id).toBe(21)

    // Marking the trigger covers everything before it.
    markAutoReplied('111', 21, NOW)
    expect(evaluateChat(getChat('111')!, NOW + 1).skip).toBe('already-answered')
  })

  it('allows a 30-second threshold with a matching cooldown', () => {
    upsertChat({ chat_id: '111', title: 'Оля', kind: 'user', defaultMode: 'log-only' })
    setAutoReply('111', { bot: 'cap', afterSeconds: 30, requireUnread: false })
    expect(getChat('111')!.auto_reply_after_s).toBe(30)
    expect(replyGapFor(getChat('111')!)).toBe(30)

    insertMessage({ chat_id: '111', msg_id: 30, direction: 'in', text: 'ало', ts: NOW - 40 })
    expect(evaluateChat(getChat('111')!, NOW).skip).toBeNull()
  })

  it('keeps a long cooldown when the chat is set to a long threshold', () => {
    upsertChat({ chat_id: '111', title: 'Оля', kind: 'user', defaultMode: 'log-only' })
    setAutoReply('111', { bot: 'cap', afterSeconds: 3600, requireUnread: false })
    expect(replyGapFor(getChat('111')!)).toBe(3600)
  })
})

describe('per-chat instruction', () => {
  it('stores and clears the prompt independently of the policy', () => {
    upsertChat({ chat_id: '111', title: 'Оля', kind: 'user', defaultMode: 'log-only' })
    setAutoReplyPrompt('111', '  пиши коротко, українською  ')
    expect(getChat('111')!.auto_reply_prompt).toBe('пиши коротко, українською')

    // Changing the delay must not wipe the instruction.
    setAutoReply('111', { bot: 'cap', afterSeconds: 60, requireUnread: false })
    expect(getChat('111')!.auto_reply_prompt).toBe('пиши коротко, українською')

    setAutoReplyPrompt('111', '')
    expect(getChat('111')!.auto_reply_prompt).toBe('')
  })
})

describe('style samples', () => {
  it('returns the owner’s own messages, newest first, without repeats', () => {
    upsertChat({ chat_id: '111', title: 'Оля', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'це не моє повідомлення', ts: NOW - 500 })
    insertMessage({ chat_id: '111', msg_id: 2, direction: 'out', text: 'ага, зараз гляну і скажу', ts: NOW - 400 })
    insertMessage({ chat_id: '111', msg_id: 3, direction: 'out', text: 'ок', ts: NOW - 300 })
    insertMessage({ chat_id: '111', msg_id: 4, direction: 'out', text: 'ага, зараз гляну і скажу', ts: NOW - 200 })
    insertMessage({ chat_id: '111', msg_id: 5, direction: 'out', text: 'та нема за що, звертайся', ts: NOW - 100 })

    const samples = getOwnerStyleSamples(10, '111')
    // 'ок' is too short to carry style; the duplicate appears once.
    expect(samples).toEqual(['та нема за що, звертайся', 'ага, зараз гляну і скажу'])
  })

  it('can look beyond one chat', () => {
    upsertChat({ chat_id: '111', title: 'Оля', kind: 'user', defaultMode: 'log-only' })
    upsertChat({ chat_id: '222', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'out', text: 'домовились, до завтра', ts: NOW - 200 })
    insertMessage({ chat_id: '222', msg_id: 1, direction: 'out', text: 'привіт, я вже в дорозі', ts: NOW - 100 })

    expect(getOwnerStyleSamples(10, '111')).toHaveLength(1)
    expect(getOwnerStyleSamples(10)).toHaveLength(2)
  })
})
