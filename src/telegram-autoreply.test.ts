import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'

const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-tg-prompt-'))
})

vi.mock('./telegram/paths.js', () => ({
  PROJECT_ROOT: testDir,
  TG_STORE_DIR: testDir,
  TG_DB_PATH: join(testDir, 'telegram.db'),
  TG_SESSION_PATH: join(testDir, 'telegram.session'),
  TG_SOCK_PATH: join(testDir, 'telegram.sock'),
  TG_PID_PATH: join(testDir, 'telegram.pid'),
  TG_LOG_PATH: join(testDir, 'telegram-observer.log'),
  TG_MEDIA_DIR: join(testDir, 'media'),
}))

// The module pulls in the bot runtime for its scheduled half; the prompt
// builders under test need none of it.
vi.mock('./env.js', () => ({ BOT_NAME: 'cap', BOT_DIR: testDir }))
vi.mock('./agent.js', () => ({ runAgent: vi.fn() }))
vi.mock('./model.js', () => ({ getBackgroundModel: () => 'test-model' }))
vi.mock('./db.js', () => ({ getSession: vi.fn(), setSession: vi.fn() }))
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('./telegram/bridge.js', () => ({ openObserver: vi.fn() }))

import {
  getTgDb, closeTgDb, upsertChat, insertMessage, setAutoReply, setAutoReplyPrompt,
  getChat, markDeletedByMsgId, setOwnerId, resetOwnerCache, getMessages,
} from './telegram/db.js'
import { buildPrimingPrompt, buildFollowUpPrompt, transcript, readable } from './telegram-autoreply.js'
import type { AutoReplyCandidate } from './telegram/autoreply.js'

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

function candidate(chatId = '111'): AutoReplyCandidate {
  const chat = getChat(chatId)!
  const trigger = getMessages(chatId, 1)[0]!
  return { chat, trigger, waitedS: 600 }
}

beforeEach(reset)

afterAll(() => {
  closeTgDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('transcript', () => {
  it('drops deleted messages instead of rendering them as empty placeholders', () => {
    upsertChat({ chat_id: '111', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'жива репліка', ts: NOW - 300 })
    insertMessage({ chat_id: '111', msg_id: 2, direction: 'in', text: 'зараз зникне', ts: NOW - 200 })
    insertMessage({ chat_id: '111', msg_id: 3, direction: 'in', text: '', media_type: 'photo', ts: NOW - 100 })
    markDeletedByMsgId(2)
    markDeletedByMsgId(3)

    const rows = getMessages('111', 50)
    expect(readable(rows).map(m => m.msg_id)).toEqual([1])

    const text = transcript(rows, 'Марта')
    expect(text).toContain('жива репліка')
    expect(text).not.toContain('[вкладення]')
    expect(text).not.toContain('[photo]')
  })

  it('names the interlocutor rather than printing a bare id', () => {
    upsertChat({ chat_id: '700100200', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    // sender_name was never resolved and fell back to the id.
    insertMessage({
      chat_id: '700100200', msg_id: 1, direction: 'in',
      sender_id: '700100200', sender_name: '700100200',
      text: 'Привіт. А ти хто?', ts: NOW - 100,
    })
    const text = transcript(getMessages('700100200', 10), 'Марта')
    expect(text).toContain('Марта: Привіт. А ти хто?')
    expect(text).not.toContain('700100200:')
  })

  it('keeps media messages that still carry a type', () => {
    upsertChat({ chat_id: '111', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: '', media_type: 'photo', ts: NOW })
    expect(transcript(getMessages('111', 10), 'Марта')).toContain('[photo]')
  })

  it('labels the owner’s own messages', () => {
    upsertChat({ chat_id: '111', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'out', sender_name: 'Олесь', text: 'ага, зроблю', ts: NOW })
    expect(transcript(getMessages('111', 10), 'Марта')).toContain('ВЛАСНИК: ага, зроблю')
  })
})

describe('priming prompt', () => {
  function seedConversation(): void {
    upsertChat({ chat_id: '111', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    for (let i = 1; i <= 12; i++) {
      insertMessage({
        chat_id: '111', msg_id: i,
        direction: i % 2 === 0 ? 'out' : 'in',
        sender_name: i % 2 === 0 ? 'Олесь' : 'Марта',
        text: i % 2 === 0 ? `ага, гляну ще раз ${i}` : `питання номер ${i}`,
        ts: NOW - (20 - i) * 60,
      })
    }
    setAutoReply('111', { bot: 'cap', afterSeconds: 120, requireUnread: false })
  }

  it('carries the conversation and asks the agent to learn its voice', () => {
    seedConversation()
    const p = buildPrimingPrompt(candidate())
    expect(p).toContain('ІСТОРІЯ ПЕРЕПИСКИ')
    expect(p).toContain('ага, гляну ще раз 12')
    expect(p).toContain('звучати як він, а не як асистент')
    // Enough of the owner's own words here — no need to borrow from elsewhere.
    expect(p).not.toContain('в інших чатах')
  })

  it('borrows the owner’s voice from other chats when this one is empty', () => {
    upsertChat({ chat_id: '111', title: 'Новий контакт', kind: 'user', defaultMode: 'log-only' })
    upsertChat({ chat_id: '222', title: 'Стара розмова', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '222', msg_id: 1, direction: 'out', text: 'та нема за що, звертайся', ts: NOW - 500 })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'добрий день', ts: NOW - 600 })
    setAutoReply('111', { bot: 'cap', afterSeconds: 120, requireUnread: false })

    const p = buildPrimingPrompt(candidate())
    expect(p).toContain('в інших чатах')
    expect(p).toContain('та нема за що, звертайся')
  })

  it('says plainly when there is no history at all', () => {
    upsertChat({ chat_id: '111', title: 'Порожній', kind: 'user', defaultMode: 'log-only' })
    setAutoReply('111', { bot: 'cap', afterSeconds: 120, requireUnread: false })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'привіт', ts: NOW - 600 })
    markDeletedByMsgId(1)
    insertMessage({ chat_id: '111', msg_id: 2, direction: 'in', text: 'ало?', ts: NOW - 600 })

    const p = buildPrimingPrompt(candidate())
    // The one live message is the trigger itself, so the history block is thin —
    // but it must never claim to show messages it does not have.
    expect(p).not.toContain('ІСТОРІЯ ПЕРЕПИСКИ\n---')
    expect(p).not.toContain('[вкладення]')
  })

  it('includes the chat’s own instruction without letting it replace the limits', () => {
    seedConversation()
    setAutoReplyPrompt('111', 'пиши коротко і без емодзі')
    const p = buildPrimingPrompt(candidate())
    expect(p).toContain('пиши коротко і без емодзі')
    expect(p.indexOf('пиши коротко і без емодзі')).toBeLessThan(p.indexOf('Межі:'))
    expect(p).toContain('Не вигадуй конкретики про власника')
  })

  it('lets the agent answer who it is, and reserves silence for invention', () => {
    seedConversation()
    const p = buildPrimingPrompt(candidate())
    expect(p).toContain('На питання «хто це?»')
    expect(p).toContain('ПРОПУСК')
  })
})

describe('follow-up prompt', () => {
  it('stays thin — no history block, no style lesson', () => {
    upsertChat({ chat_id: '111', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    // A real conversation, so the two paths are compared at the sizes they
    // actually reach: 200 primed messages against a 20-message window.
    for (let i = 1; i <= 200; i++) {
      insertMessage({
        chat_id: '111', msg_id: i,
        direction: i % 2 === 0 ? 'out' : 'in',
        text: `рядок номер ${i} у цій розмові`,
        ts: NOW - (220 - i) * 60,
      })
    }
    setAutoReply('111', { bot: 'cap', afterSeconds: 120, requireUnread: false })

    const priming = buildPrimingPrompt(candidate())
    const followUp = buildFollowUpPrompt(candidate())

    expect(followUp).not.toContain('ІСТОРІЯ ПЕРЕПИСКИ')
    expect(followUp).not.toContain('звучати як він')
    expect(followUp.length).toBeLessThan(priming.length / 2)
    // Both paths must impose the same limits.
    expect(followUp).toContain('Не вигадуй конкретики про власника')
  })
})
