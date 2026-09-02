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
vi.mock('./env.js', () => ({ BOT_NAME: 'cap', BOT_DIR: testDir, readEnvFile: () => ({}) }))
// config.ts derives per-bot constants at import time; the prompt builders only
// need the owner's chat id, and an empty one keeps notifications out of tests.
vi.mock('./config.js', () => ({ ALLOWED_CHAT_ID: '', STORE_DIR: testDir, PROJECT_ROOT: testDir }))
vi.mock('./bot.js', () => ({ sendMessage: vi.fn() }))
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
  setAutoReplyContext, resetAutoReplyContext, countMessagesAfter, getOwnerStyleSamples,
} from './telegram/db.js'
import {
  buildPrimingPrompt, buildFollowUpPrompt, transcript, readable, pollIntervalMs, seedGroupArchive,
} from './telegram-autoreply.js'
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
    setAutoReply('111', { bot: 'cap', afterSeconds: 120, requireUnread: false, mentionOnly: false })
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
    setAutoReply('111', { bot: 'cap', afterSeconds: 120, requireUnread: false, mentionOnly: false })

    const p = buildPrimingPrompt(candidate())
    expect(p).toContain('в інших чатах')
    expect(p).toContain('та нема за що, звертайся')
  })

  it('says plainly when there is no history at all', () => {
    upsertChat({ chat_id: '111', title: 'Порожній', kind: 'user', defaultMode: 'log-only' })
    setAutoReply('111', { bot: 'cap', afterSeconds: 120, requireUnread: false, mentionOnly: false })
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
    expect(p).toContain('Не стверджуй конкретики про власника')
  })

  it('lets the agent answer who it is, and reserves silence for invention', () => {
    seedConversation()
    const p = buildPrimingPrompt(candidate())
    expect(p).toContain('На питання «хто це?»')
    expect(p).toContain('ПРОПУСК')
  })

  it('asks for a reason next to the skip token, so silence is never blank', () => {
    seedConversation()
    const p = buildPrimingPrompt(candidate())
    expect(p).toContain('ПРОПУСК: <причина в кілька слів>')
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
    setAutoReply('111', { bot: 'cap', afterSeconds: 120, requireUnread: false, mentionOnly: false })

    const priming = buildPrimingPrompt(candidate())
    // A session that is up to date has nothing to catch up on: thinness comes
    // from the marker, not from the code path.
    resetAutoReplyContext('111', 199)
    const followUp = buildFollowUpPrompt(candidate())

    expect(followUp).not.toContain('ІСТОРІЯ ПЕРЕПИСКИ')
    expect(followUp).not.toContain('звучати як він')
    expect(followUp.length).toBeLessThan(priming.length / 2)
    // Both paths must impose the same limits.
    expect(followUp).toContain('Не стверджуй конкретики про власника')
  })
})

describe('poll interval', () => {
  it('follows the shortest threshold in use', () => {
    // A 30-second setting must not be swallowed by a one-minute tick.
    expect(pollIntervalMs([30])).toBe(10_000)
    expect(pollIntervalMs([60])).toBe(20_000)
    expect(pollIntervalMs([300])).toBe(60_000)
  })

  it('is driven by the fastest chat, not the average', () => {
    expect(pollIntervalMs([3600, 1800, 30])).toBe(10_000)
  })

  it('never churns below the floor and never sleeps past a minute', () => {
    expect(pollIntervalMs([1])).toBe(5_000)
    expect(pollIntervalMs([86_400])).toBe(60_000)
  })

  it('idles at the slowest rate when no chat is configured', () => {
    expect(pollIntervalMs([])).toBe(60_000)
  })
})

describe('limits', () => {
  it('treats "I do not remember" as an answer, not a reason to stay silent', () => {
    upsertChat({ chat_id: '111', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'ми ж разом росли, пам’ятаєш?', ts: NOW - 600 })
    setAutoReply('111', { bot: 'cap', afterSeconds: 30, requireUnread: false, mentionOnly: false })

    const p = buildPrimingPrompt(candidate())
    expect(p).toContain('не пригадую')
    expect(p).toContain('краща за мовчання')
    // Silence stays reserved for the case where any answer would be invention.
    expect(p).toContain('Незнання, сумнів чи дрібна побутова репліка на це не тягнуть')
  })
})

describe('the gap the owner leaves behind', () => {
  /** A chat the session has already answered up to `seenUpTo`. */
  function primedChat(seenUpTo: number): void {
    upsertChat({ chat_id: '111', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    setAutoReply('111', { bot: 'cap', afterSeconds: 30, requireUnread: false, mentionOnly: false })
    resetAutoReplyContext('111', seenUpTo)
  }

  it('shows everything the owner exchanged by hand in between', () => {
    primedChat(10)
    // The owner took over: his replies and hers, none of it seen by the session.
    insertMessage({ chat_id: '111', msg_id: 11, direction: 'in', text: 'а ти вже дивився документ?', ts: NOW - 900 })
    insertMessage({ chat_id: '111', msg_id: 12, direction: 'out', text: 'так, глянув, там усе ок', ts: NOW - 880 })
    insertMessage({ chat_id: '111', msg_id: 13, direction: 'in', text: 'супер, тоді я надсилаю', ts: NOW - 860 })
    insertMessage({ chat_id: '111', msg_id: 14, direction: 'in', text: 'надіслала, глянеш?', ts: NOW - 600 })

    const p = buildFollowUpPrompt(candidate())
    expect(p).toContain('а ти вже дивився документ?')
    expect(p).toContain('ВЛАСНИК: так, глянув, там усе ок')
    expect(p).toContain('супер, тоді я надсилаю')
    expect(p).toContain('надіслала, глянеш?')
    expect(p).toContain('Власник частину цієї розмови вів сам')
  })

  it('never re-shows what the session already saw', () => {
    primedChat(10)
    insertMessage({ chat_id: '111', msg_id: 5, direction: 'in', text: 'давня репліка', ts: NOW - 5000 })
    insertMessage({ chat_id: '111', msg_id: 11, direction: 'in', text: 'нова репліка', ts: NOW - 600 })

    const p = buildFollowUpPrompt(candidate())
    expect(p).toContain('нова репліка')
    expect(p).not.toContain('давня репліка')
  })

  it('admits how much it had to leave out on a very long gap', () => {
    primedChat(0)
    for (let i = 1; i <= 200; i++) {
      insertMessage({
        chat_id: '111', msg_id: i,
        direction: i % 3 === 0 ? 'out' : 'in',
        text: `повідомлення ${i}`,
        ts: NOW - (300 - i) * 10,
      })
    }
    expect(countMessagesAfter('111', 0)).toBe(200)

    const p = buildFollowUpPrompt(candidate())
    expect(p).toContain('було 200 повідомлень')
    expect(p).toContain('нижче лише останні 120')
    expect(p).toContain('не роби вигляд, що знаєш їхній зміст')
    // Newest survive the truncation; the oldest of the gap are the ones dropped.
    expect(p).toContain('повідомлення 200')
    expect(p).not.toContain('повідомлення 1\n')
  })

  it('falls back to the recent thread when nothing is new', () => {
    primedChat(50)
    for (let i = 1; i <= 5; i++) {
      insertMessage({ chat_id: '111', msg_id: i, direction: 'in', text: `рядок ${i}`, ts: NOW - 600 })
    }
    const p = buildFollowUpPrompt(candidate())
    expect(p).toContain('Останні повідомлення в чаті')
    expect(p).toContain('рядок 5')
  })

  it('advances the marker without ever moving it backwards', () => {
    primedChat(10)
    setAutoReplyContext('111', 25)
    expect(getChat('111')!.auto_reply_ctx_msg_id).toBe(25)
    setAutoReplyContext('111', 15)
    expect(getChat('111')!.auto_reply_ctx_msg_id).toBe(25)
  })

  it('keeps "seen" separate from "answered"', () => {
    primedChat(10)
    insertMessage({ chat_id: '111', msg_id: 11, direction: 'in', text: 'питання', ts: NOW - 600 })
    // The owner answered this one himself — the bot never did.
    insertMessage({ chat_id: '111', msg_id: 12, direction: 'out', text: 'відповів сам', ts: NOW - 500 })
    setAutoReplyContext('111', 12)

    const chat = getChat('111')!
    expect(chat.auto_reply_ctx_msg_id).toBe(12)
    expect(chat.auto_reply_last_msg_id).toBeLessThan(12)
  })
})

describe('group prompts', () => {
  function groupChat(): void {
    upsertChat({ chat_id: '900', title: 'Робоча група', kind: 'supergroup', defaultMode: 'log-only' })
    for (let i = 1; i <= 20; i++) {
      insertMessage({
        chat_id: '900', msg_id: i,
        direction: i % 5 === 0 ? 'out' : 'in',
        sender_id: i % 5 === 0 ? null : String(i % 3),
        sender_name: i % 5 === 0 ? 'Олесь' : ['Петро', 'Ніна', 'Богдан'][i % 3],
        text: `репліка ${i}`,
        ts: NOW - (40 - i) * 60,
      })
    }
    setAutoReply('900', { bot: 'cap', afterSeconds: 300, requireUnread: false, mentionOnly: true })
  }

  it('frames the chat as a room, not a private conversation', () => {
    groupChat()
    const p = buildPrimingPrompt(candidate('900'))
    expect(p).toContain('груповому чаті')
    expect(p).toContain('хто тут хто')
    expect(p).not.toContain('приватну переписку')
  })

  it('names the message being answered and forbids joining other threads', () => {
    groupChat()
    const p = buildPrimingPrompt(candidate('900'))
    expect(p).toContain('до власника звернулися')
    expect(p).toContain('Решта розмови — контекст, не привід вступати в неї')
    expect(p).toContain('Не коментуй чужі репліки')
  })

  it('leaves the group rule out of a private chat', () => {
    upsertChat({ chat_id: '111', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'привіт', ts: NOW - 600 })
    setAutoReply('111', { bot: 'cap', afterSeconds: 300, requireUnread: false, mentionOnly: false })

    const p = buildPrimingPrompt(candidate())
    expect(p).not.toContain('Не коментуй чужі репліки')
    expect(p).not.toContain('до власника звернулися')
  })
})

describe('the owner’s own lines in a group', () => {
  it('lifts them out so his voice is not buried under everyone else’s', () => {
    upsertChat({ chat_id: '900', title: 'Робоча група', kind: 'supergroup', defaultMode: 'log-only' })
    // A busy room: many voices, a handful of his.
    for (let i = 1; i <= 60; i++) {
      insertMessage({
        chat_id: '900', msg_id: i, direction: 'in',
        sender_id: String(i % 4), sender_name: ['Петро', 'Ніна', 'Богдан', 'Оля'][i % 4],
        text: `чужа репліка номер ${i}`, ts: NOW - (100 - i) * 60,
      })
    }
    insertMessage({ chat_id: '900', msg_id: 61, direction: 'out', text: 'та зроблю до вечора, не питання', ts: NOW - 2000 })
    insertMessage({ chat_id: '900', msg_id: 62, direction: 'out', text: 'ага, я на звʼязку', ts: NOW - 1900 })
    insertMessage({ chat_id: '900', msg_id: 63, direction: 'out', text: 'дайте мені пів години', ts: NOW - 1800 })
    insertMessage({ chat_id: '900', msg_id: 64, direction: 'in', sender_id: '1', sender_name: 'Ніна', text: 'то як там?', ts: NOW - 600 })
    setAutoReply('900', { bot: 'cap', afterSeconds: 300, requireUnread: false, mentionOnly: true })

    const p = buildPrimingPrompt(candidate('900'))
    expect(p).toContain('лише репліки самого власника в цій групі')
    expect(p).toContain('та зроблю до вечора, не питання')
    expect(p).toContain('дайте мені пів години')
    // Still the whole room as context, not just his half.
    expect(p).toContain('чужа репліка номер 60')
  })

  it('does not add the block to a private chat', () => {
    upsertChat({ chat_id: '111', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    for (let i = 1; i <= 10; i++) {
      insertMessage({
        chat_id: '111', msg_id: i,
        direction: i % 2 === 0 ? 'out' : 'in',
        text: i % 2 === 0 ? `моя репліка ${i}` : `її репліка ${i}`,
        ts: NOW - (30 - i) * 60,
      })
    }
    setAutoReply('111', { bot: 'cap', afterSeconds: 300, requireUnread: false, mentionOnly: false })
    expect(buildPrimingPrompt(candidate())).not.toContain('лише репліки самого власника')
  })

  it('skips the block when he has barely written in the group', () => {
    upsertChat({ chat_id: '900', title: 'Тиха група', kind: 'supergroup', defaultMode: 'log-only' })
    insertMessage({ chat_id: '900', msg_id: 1, direction: 'out', text: 'єдина моя репліка тут', ts: NOW - 2000 })
    insertMessage({ chat_id: '900', msg_id: 2, direction: 'in', sender_id: '1', sender_name: 'Ніна', text: 'агов?', ts: NOW - 600 })
    setAutoReply('900', { bot: 'cap', afterSeconds: 300, requireUnread: false, mentionOnly: true })

    expect(buildPrimingPrompt(candidate('900'))).not.toContain('лише репліки самого власника')
  })
})

describe('long messages of the owner', () => {
  const LONG = 'Слухай, я тут довго думав над цим питанням і хочу розкласти по пунктах, бо інакше ми знову загубимо суть. '.repeat(12)

  it('trims his own long line in the transcript instead of dropping it', () => {
    upsertChat({ chat_id: '900', title: 'Робоча група', kind: 'supergroup', defaultMode: 'log-only' })
    insertMessage({ chat_id: '900', msg_id: 1, direction: 'out', text: LONG, ts: NOW - 600 })

    const text = transcript(getMessages('900', 10), 'Робоча група')
    expect(text).toContain('Слухай, я тут довго думав')
    expect(text).toContain('[обрізано]')
    expect(text.length).toBeLessThan(LONG.length)
  })

  it('leaves other people’s long messages intact', () => {
    upsertChat({ chat_id: '900', title: 'Робоча група', kind: 'supergroup', defaultMode: 'log-only' })
    insertMessage({ chat_id: '900', msg_id: 1, direction: 'in', sender_name: 'Ніна', text: LONG, ts: NOW - 600 })

    const text = transcript(getMessages('900', 10), 'Робоча група')
    expect(text).not.toContain('[обрізано]')
    expect(text).toContain(LONG.trim())
  })

  it('keeps a long message as a style sample, trimmed', () => {
    upsertChat({ chat_id: '900', title: 'Робоча група', kind: 'supergroup', defaultMode: 'log-only' })
    insertMessage({ chat_id: '900', msg_id: 1, direction: 'out', text: LONG, ts: NOW - 900 })

    const samples = getOwnerStyleSamples(10, '900', 300)
    // Previously a message this long was filtered out entirely.
    expect(samples).toHaveLength(1)
    expect(samples[0]!.length).toBeLessThanOrEqual(301)
    expect(samples[0]!.endsWith('…')).toBe(true)
  })

  it('keeps short real replies that a higher floor would have discarded', () => {
    upsertChat({ chat_id: '900', title: 'Робоча група', kind: 'supergroup', defaultMode: 'log-only' })
    insertMessage({ chat_id: '900', msg_id: 1, direction: 'out', text: 'ага, зроблю', ts: NOW - 900 })
    insertMessage({ chat_id: '900', msg_id: 2, direction: 'out', text: 'ок', ts: NOW - 800 })

    const samples = getOwnerStyleSamples(10, '900')
    expect(samples).toContain('ага, зроблю')
    expect(samples).not.toContain('ок')
  })
})

describe('seeding a group archive', () => {
  /** Records what the observer was asked to do. */
  function fakeObserver() {
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    return {
      calls,
      session: {
        call: async (tool: string, args: Record<string, unknown>) => {
          calls.push({ tool, args })
          return 'Додано 0 нових повідомлень'
        },
        close: async () => undefined,
      },
    }
  }

  function thinGroup(kind: 'supergroup' | 'user'): void {
    upsertChat({ chat_id: '900', title: 'Робоча група', kind, defaultMode: 'log-only' })
    insertMessage({ chat_id: '900', msg_id: 1, direction: 'out', text: 'єдина моя репліка', ts: NOW - 900 })
    insertMessage({ chat_id: '900', msg_id: 2, direction: 'in', sender_id: '3', sender_name: 'Ніна', text: 'агов?', ts: NOW - 600 })
    setAutoReply('900', { bot: 'cap', afterSeconds: 300, requireUnread: false, mentionOnly: true })
  }

  it('tops up a group whose archive holds almost nothing of the owner', async () => {
    thinGroup('supergroup')
    const obs = fakeObserver()
    await seedGroupArchive(obs.session, candidate('900'))

    expect(obs.calls).toHaveLength(1)
    expect(obs.calls[0]!.tool).toBe('tg_seed_chat')
    expect(obs.calls[0]!.args['chat']).toBe('900')
  })

  it('never touches a private chat', async () => {
    thinGroup('user')
    const obs = fakeObserver()
    await seedGroupArchive(obs.session, candidate('900'))
    expect(obs.calls).toEqual([])
  })

  it('leaves a group alone once its archive is deep enough', async () => {
    upsertChat({ chat_id: '900', title: 'Жива група', kind: 'supergroup', defaultMode: 'log-only' })
    for (let i = 1; i <= 40; i++) {
      insertMessage({ chat_id: '900', msg_id: i, direction: 'out', text: `моя репліка номер ${i}`, ts: NOW - (60 - i) * 60 })
    }
    insertMessage({ chat_id: '900', msg_id: 50, direction: 'in', sender_id: '3', sender_name: 'Ніна', text: 'то як?', ts: NOW - 600 })
    setAutoReply('900', { bot: 'cap', afterSeconds: 300, requireUnread: false, mentionOnly: true })

    const obs = fakeObserver()
    await seedGroupArchive(obs.session, candidate('900'))
    expect(obs.calls).toEqual([])
  })

  it('still primes when the top-up fails', async () => {
    thinGroup('supergroup')
    const failing = {
      call: async () => { throw new Error('observer down') },
      close: async () => undefined,
    }
    await expect(seedGroupArchive(failing, candidate('900'))).resolves.toBeUndefined()
  })
})
