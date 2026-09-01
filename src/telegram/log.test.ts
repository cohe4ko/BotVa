import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'

const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-tg-log-'))
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

vi.mock('telegram/Utils.js', () => ({
  getPeerId: (e: { id?: unknown }) => String(e.id ?? '0'),
  getDisplayName: (e: { title?: string; firstName?: string }) => e.title ?? e.firstName ?? '',
}))

import { handleNewMessage, handleEditedMessage, handleDeletedMessages, catchUp, stats } from './log.js'
import {
  getTgDb, closeTgDb, getChat, getMessages, countMessages, setChatMode,
  upsertChat, insertMessage, getCursor,
  type ChatMode,
} from './db.js'

interface FakeChat { className: string; id: number; title?: string; firstName?: string; bot?: boolean; megagroup?: boolean }

/** Minimal stand-in for Api.Message — only the fields the logger touches. */
function fakeMessage(opts: {
  id: number
  chat: FakeChat
  text?: string
  out?: boolean
  date?: number
  media?: { className: string }
  sender?: { firstName: string }
  replyToMsgId?: number
}) {
  return {
    id: opts.id,
    message: opts.text ?? '',
    out: opts.out ?? false,
    date: opts.date ?? 1000,
    senderId: 42,
    media: opts.media,
    replyTo: opts.replyToMsgId ? { replyToMsgId: opts.replyToMsgId } : undefined,
    getChat: async () => opts.chat,
    getSender: async () => opts.sender ?? { firstName: 'Петро' },
  } as never
}

const privateChat: FakeChat = { className: 'User', id: 111, firstName: 'Петро' }
const botChat: FakeChat = { className: 'User', id: 222, firstName: 'BotVa', bot: true }
const superGroup: FakeChat = { className: 'Channel', id: 333, title: 'Велика', megagroup: true }
const basicGroup: FakeChat = { className: 'Chat', id: 444, title: 'Сімʼя' }

function resetDb(): void {
  const d = getTgDb()
  d.exec('DELETE FROM tg_messages')
  d.exec('DELETE FROM tg_messages_fts')
  d.exec('DELETE FROM tg_chats')
  d.exec('DELETE FROM tg_cursor')
  stats.seen = 0
  stats.stored = 0
  stats.skipped = 0
}

beforeEach(() => {
  resetDb()
})

afterAll(() => {
  closeTgDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('chat registration', () => {
  it('registers an unseen private chat with the log-only default', async () => {
    await handleNewMessage(fakeMessage({ id: 1, chat: privateChat, text: 'привіт' }))
    const chat = getChat('111')!
    expect(chat.kind).toBe('user')
    expect(chat.mode).toBe('log-only')
  })

  it('registers a bot chat as ignore and stores nothing', async () => {
    await handleNewMessage(fakeMessage({ id: 1, chat: botChat, text: 'звіт від бота' }))
    expect(getChat('222')!.mode).toBe('ignore')
    expect(countMessages().total).toBe(0)
    expect(stats.skipped).toBe(1)
  })

  it('skips supergroups by default but still registers them for later opt-in', async () => {
    await handleNewMessage(fakeMessage({ id: 1, chat: superGroup, text: 'флуд' }))
    expect(getChat('-100333') ?? getChat('333')).toBeTruthy()
    expect(countMessages().total).toBe(0)
  })

  it('logs basic groups', async () => {
    await handleNewMessage(fakeMessage({ id: 1, chat: basicGroup, text: 'вечеря о 19' }))
    expect(countMessages().total).toBe(1)
  })
})

describe('logging policy', () => {
  it('stores outgoing messages — they carry the owner\'s own commitments', async () => {
    await handleNewMessage(fakeMessage({ id: 1, chat: privateChat, text: 'зроблю до п\'ятниці', out: true }))
    const rows = getMessages('111')
    expect(rows).toHaveLength(1)
    expect(rows[0].direction).toBe('out')
  })

  it('skips messages with neither text nor media', async () => {
    await handleNewMessage(fakeMessage({ id: 1, chat: privateChat, text: '' }))
    expect(countMessages().total).toBe(0)
    expect(stats.skipped).toBe(1)
  })

  it('stores a media message that has no caption', async () => {
    await handleNewMessage(fakeMessage({
      id: 1, chat: privateChat, text: '', media: { className: 'MessageMediaPhoto' },
    }))
    const rows = getMessages('111')
    expect(rows).toHaveLength(1)
    expect(rows[0].media_type).toBe('photo')
  })

  it('respects a user-chosen ignore mode on an already-known chat', async () => {
    await handleNewMessage(fakeMessage({ id: 1, chat: privateChat, text: 'перше' }))
    setChatMode('111', 'ignore')
    await handleNewMessage(fakeMessage({ id: 2, chat: privateChat, text: 'друге' }))
    expect(getMessages('111')).toHaveLength(1)
  })

  it('logs in every non-ignore mode', async () => {
    for (const mode of ['log-only', 'facts-only', 'full'] as ChatMode[]) {
      resetDb()
      await handleNewMessage(fakeMessage({ id: 1, chat: privateChat, text: 'реєстрація' }))
      setChatMode('111', mode)
      await handleNewMessage(fakeMessage({ id: 2, chat: privateChat, text: 'друге' }))
      expect(getMessages('111'), `mode ${mode}`).toHaveLength(2)
    }
  })

  it('keeps the reply reference', async () => {
    await handleNewMessage(fakeMessage({ id: 5, chat: privateChat, text: 'так', replyToMsgId: 3 }))
    expect(getMessages('111')[0].reply_to).toBe(3)
  })

  it('counts what it saw, stored and skipped', async () => {
    await handleNewMessage(fakeMessage({ id: 1, chat: privateChat, text: 'ок' }))
    await handleNewMessage(fakeMessage({ id: 2, chat: botChat, text: 'бот' }))
    expect(stats.seen).toBe(2)
    expect(stats.stored).toBe(1)
    expect(stats.skipped).toBe(1)
  })

  it('survives a message whose chat cannot be resolved', async () => {
    const broken = {
      id: 1, message: 'x', out: false, date: 1, senderId: 1,
      getChat: async () => { throw new Error('no access hash') },
      getSender: async () => null,
    } as never
    await expect(handleNewMessage(broken)).resolves.toBeUndefined()
    expect(countMessages().total).toBe(0)
  })
})

describe('edits and deletions', () => {
  it('applies an edit to a logged message', async () => {
    await handleNewMessage(fakeMessage({ id: 1, chat: privateChat, text: 'о 15' }))
    await handleEditedMessage(fakeMessage({ id: 1, chat: privateChat, text: 'о 16' }))
    expect(getMessages('111')[0].text).toBe('о 16')
  })

  it('ignores an edit in a chat that is not logged', async () => {
    await handleNewMessage(fakeMessage({ id: 1, chat: botChat, text: 'a' }))
    await expect(handleEditedMessage(fakeMessage({ id: 1, chat: botChat, text: 'b' }))).resolves.toBeUndefined()
  })

  it('tombstones deletions reported without a chat', async () => {
    await handleNewMessage(fakeMessage({ id: 77, chat: privateChat, text: 'зникне' }))
    handleDeletedMessages([77])
    const row = getMessages('111')[0]
    expect(row.deleted_ts).not.toBeNull()
    expect(row.text).toBe('')
  })

  it('ignores deletions for unknown message ids', () => {
    expect(() => handleDeletedMessages([999, 1000])).not.toThrow()
  })
})

describe('catch-up after downtime', () => {
  /** Stand-in for TelegramClient.getMessages, recording how it was called. */
  function fakeClient(byChat: Record<string, unknown[]>, calls: { chat: string; opts: Record<string, unknown> }[] = []) {
    return {
      calls,
      getMessages: async (chat: string, opts: Record<string, unknown>) => {
        calls.push({ chat, opts })
        return byChat[chat] ?? []
      },
    } as never
  }

  function histMessage(id: number, text: string, ts: number, out = false) {
    return {
      id, message: text, out, date: ts, senderId: 42,
      getSender: async () => ({ firstName: 'Петро' }),
    }
  }

  it('resumes from the cursor instead of refetching everything', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 10, direction: 'in', text: 'старе', ts: 1000 })
    expect(getCursor('111')).toBe(10)

    const calls: { chat: string; opts: Record<string, unknown> }[] = []
    await catchUp(fakeClient({ '111': [histMessage(11, 'пропущене', 2000)] }, calls))

    expect(calls[0].opts['minId']).toBe(10)
    expect(getMessages('111').map(m => m.text)).toContain('пропущене')
  })

  it('takes a small recent slice for a chat with no cursor, not a full backfill', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    const calls: { chat: string; opts: Record<string, unknown> }[] = []
    await catchUp(fakeClient({ '111': [] }, calls))

    expect(calls[0].opts['minId']).toBeUndefined()
    expect(calls[0].opts['limit']).toBe(20)
  })

  it('never touches ignored chats', async () => {
    upsertChat({ chat_id: '222', title: 'Канал', kind: 'channel', defaultMode: 'ignore' })
    const calls: { chat: string; opts: Record<string, unknown> }[] = []
    await catchUp(fakeClient({}, calls))
    expect(calls).toHaveLength(0)
  })

  it('does not duplicate messages already in the log', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    insertMessage({ chat_id: '111', msg_id: 10, direction: 'in', text: 'вже є', ts: 1000 })
    const result = await catchUp(fakeClient({ '111': [histMessage(10, 'вже є', 1000)] }))
    expect(countMessages().total).toBe(1)
    expect(result.stored).toBe(0)
  })

  it('reports counts of what it recovered', async () => {
    upsertChat({ chat_id: '111', title: 'Петро', kind: 'user', defaultMode: 'log-only' })
    const result = await catchUp(fakeClient({
      '111': [histMessage(1, 'a', 100), histMessage(2, 'b', 200, true)],
    }))
    expect(result.stored).toBe(2)
    expect(result.chats).toBe(1)
  })

  it('skips a chat on FloodWait and keeps going', async () => {
    upsertChat({ chat_id: '111', title: 'Перший', kind: 'user', defaultMode: 'log-only' })
    upsertChat({ chat_id: '222', title: 'Другий', kind: 'user', defaultMode: 'log-only' })

    const client = {
      getMessages: async (chat: string) => {
        if (chat === '111') throw new Error('A wait of 42 seconds is required (FLOOD_WAIT)')
        return [histMessage(5, 'дійшло', 500)]
      },
    } as never

    const result = await catchUp(client)
    expect(result.floodWaits).toBe(1)
    expect(getMessages('222').map(m => m.text)).toContain('дійшло')
  }, 15000)
})
