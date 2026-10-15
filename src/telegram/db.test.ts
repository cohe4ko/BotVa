import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'

// vi.hoisted runs before vi.mock hoisting
const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-tg-test-'))
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
  getTgDb, closeTgDb, upsertChat, getChat, listChats, countChats, setChatMode, setChatCanSend,
  setChatUnread, touchChatActivity, listUnreadChats, insertMessage, markEdited, markDeleted,
  markDeletedByMsgId, getMessages, getRecentMessages, searchMessages, countMessages,
  getCursor, recordOutbox, listOutbox, countOutboxSince,
  noteApiCall, getApiCalls, pruneApiCalls,
  getOwnerId, setOwnerId, resetOwnerCache, countForeignRows, purgeForeignRows, LEGACY_OWNER,
  notePersonSeen, upsertPerson, setPersonProfile, getPerson, listPeople, countPeople,
  personName, syncChatMembers, listChatMembers, chatMembersSyncedAt,
} from './db.js'

function resetDb(): void {
  const d = getTgDb()
  d.exec('DELETE FROM tg_messages')
  d.exec('DELETE FROM tg_messages_fts')
  d.exec('DELETE FROM tg_chats')
  d.exec('DELETE FROM tg_cursor')
  d.exec('DELETE FROM tg_outbox')
  d.exec('DELETE FROM tg_people')
  d.exec('DELETE FROM tg_chat_members')
  d.exec("DELETE FROM tg_meta WHERE key = 'owner_id'")
  resetOwnerCache()
}

function makeChat(id = '111', overrides: Partial<Parameters<typeof upsertChat>[0]> = {}) {
  return upsertChat({
    chat_id: id,
    title: 'Тест',
    username: 'test',
    kind: 'user',
    defaultMode: 'log-only',
    ...overrides,
  })
}

beforeEach(() => {
  resetDb()
})

afterAll(() => {
  closeTgDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('chats', () => {
  it('registers a chat with its default mode', () => {
    const chat = makeChat()
    expect(chat.chat_id).toBe('111')
    expect(chat.mode).toBe('log-only')
    expect(chat.can_send).toBe(0)
  })

  it('refreshes metadata without overwriting a chosen mode', () => {
    makeChat()
    setChatMode('111', 'full')
    upsertChat({ chat_id: '111', title: 'Нова назва', kind: 'user', defaultMode: 'log-only' })
    const chat = getChat('111')!
    expect(chat.title).toBe('Нова назва')
    // upsert passes the existing mode back in; the row must not silently reset
    expect(chat.mode).toBe('full')
  })

  it('toggles send permission', () => {
    makeChat()
    expect(getChat('111')!.can_send).toBe(0)
    setChatCanSend('111', true)
    expect(getChat('111')!.can_send).toBe(1)
    setChatCanSend('111', false)
    expect(getChat('111')!.can_send).toBe(0)
  })

  it('lists only chats with unread messages', () => {
    makeChat('111')
    makeChat('222', { title: 'Другий' })
    setChatUnread('222', 3)
    const unread = listUnreadChats()
    expect(unread).toHaveLength(1)
    expect(unread[0].chat_id).toBe('222')
  })

  it('filters by kind', () => {
    makeChat('111')
    makeChat('222', { kind: 'channel' })
    expect(listChats({ kind: 'channel' })).toHaveLength(1)
  })
})

describe('chat listing at scale', () => {
  const now = Math.floor(Date.now() / 1000)

  function seed(count: number): void {
    for (let i = 1; i <= count; i++) {
      makeChat(String(i), { title: `Чат ${i}` })
      // Newest first: chat 1 is the most recent.
      touchChatActivity(String(i), now - i * 60)
    }
  }

  it('never returns everything by default', () => {
    seed(120)
    // An unbounded read here is what would hang a thousand-dialog account.
    expect(listChats().length).toBe(50)
  })

  it('pages without gaps or repeats', () => {
    seed(60)
    const first = listChats({ limit: 25, offset: 0 }).map(c => c.chat_id)
    const second = listChats({ limit: 25, offset: 25 }).map(c => c.chat_id)
    expect(first).toHaveLength(25)
    expect(second).toHaveLength(25)
    expect(new Set([...first, ...second]).size).toBe(50)
  })

  it('orders by recency, newest first', () => {
    seed(5)
    expect(listChats({ limit: 5 }).map(c => c.chat_id)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('counts the filtered set, not the table', () => {
    seed(40)
    const opts = { limit: 10, search: 'Чат 1' }
    expect(listChats(opts).length).toBe(10)
    // "Чат 1", "Чат 1x" — the count must reflect the same filter as the page.
    expect(countChats(opts)).toBe(countChats({ search: 'Чат 1' }))
    expect(countChats({})).toBe(40)
  })

  it('searches by title, username and exact id', () => {
    makeChat('555', { title: 'Ольга Козак', username: 'olha' })
    makeChat('666', { title: 'Петро', username: 'petro' })
    expect(listChats({ search: 'козак' }).map(c => c.chat_id)).toEqual(['555'])
    expect(listChats({ search: 'PETRO' }).map(c => c.chat_id)).toEqual(['666'])
    expect(listChats({ search: '555' }).map(c => c.chat_id)).toEqual(['555'])
  })

  it('excludes chats older than the activity window', () => {
    makeChat('111', { title: 'Свіжий' })
    touchChatActivity('111', now - 3600)
    makeChat('222', { title: 'Давній' })
    touchChatActivity('222', now - 90 * 86400)

    const recent = listChats({ activeSince: now - 7 * 86400 })
    expect(recent.map(c => c.chat_id)).toEqual(['111'])
    expect(countChats({ activeSince: now - 7 * 86400 })).toBe(1)
  })

  it('treats a chat with no activity as excluded from the window', () => {
    makeChat('111', { title: 'Без активності' })
    expect(listChats({ activeSince: now - 86400 })).toHaveLength(0)
  })

  it('keeps activity monotonic so a stale snapshot cannot rewind a chat', () => {
    makeChat('111')
    touchChatActivity('111', 5000)
    touchChatActivity('111', 1000)
    expect(getChat('111')!.last_msg_ts).toBe(5000)
  })
})

describe('messages', () => {
  it('stores a message and advances the cursor', () => {
    makeChat()
    const stored = insertMessage({
      chat_id: '111', msg_id: 10, direction: 'in',
      sender_name: 'Петро', text: 'привіт', ts: 1000,
    })
    expect(stored).toBe(true)
    expect(getCursor('111')).toBe(10)
    expect(getChat('111')!.last_msg_ts).toBe(1000)
  })

  it('ignores a re-delivered message (daemon restart catch-up)', () => {
    makeChat()
    const first = insertMessage({ chat_id: '111', msg_id: 10, direction: 'in', text: 'привіт', ts: 1000 })
    const second = insertMessage({ chat_id: '111', msg_id: 10, direction: 'in', text: 'привіт', ts: 1000 })
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(countMessages().total).toBe(1)
  })

  it('never moves the cursor backwards', () => {
    makeChat()
    insertMessage({ chat_id: '111', msg_id: 20, direction: 'in', text: 'нове', ts: 2000 })
    insertMessage({ chat_id: '111', msg_id: 5, direction: 'in', text: 'старе', ts: 500 })
    expect(getCursor('111')).toBe(20)
  })

  it('counts directions separately', () => {
    makeChat()
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'a', ts: 1 })
    insertMessage({ chat_id: '111', msg_id: 2, direction: 'out', text: 'b', ts: 2 })
    insertMessage({ chat_id: '111', msg_id: 3, direction: 'out', text: 'c', ts: 3 })
    const counts = countMessages()
    expect(counts.total).toBe(3)
    expect(counts.incoming).toBe(1)
    expect(counts.outgoing).toBe(2)
    expect(counts.chats).toBe(1)
  })

  it('filters recent messages by direction', () => {
    makeChat()
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'вхідне', ts: 1 })
    insertMessage({ chat_id: '111', msg_id: 2, direction: 'out', text: 'вихідне', ts: 2 })
    const outgoing = getRecentMessages(10, 'out')
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0].text).toBe('вихідне')
  })

  it('returns messages newest first, limited', () => {
    makeChat()
    for (let i = 1; i <= 5; i++) {
      insertMessage({ chat_id: '111', msg_id: i, direction: 'in', text: `msg${i}`, ts: i * 100 })
    }
    const rows = getMessages('111', 3)
    expect(rows).toHaveLength(3)
    expect(rows[0].text).toBe('msg5')
  })
})

describe('edits and deletions', () => {
  it('records an edit and keeps the new text searchable', () => {
    makeChat()
    insertMessage({ chat_id: '111', msg_id: 10, direction: 'in', text: 'старий текст', ts: 1000 })
    markEdited('111', 10, 'новий текст')
    const row = getMessages('111', 1)[0]
    expect(row.text).toBe('новий текст')
    expect(row.edited_ts).not.toBeNull()
    expect(searchMessages('новий')).toHaveLength(1)
    expect(searchMessages('старий')).toHaveLength(0)
  })

  it('tombstones a deleted message instead of dropping the row', () => {
    makeChat()
    insertMessage({ chat_id: '111', msg_id: 10, direction: 'in', text: 'секрет', ts: 1000 })
    markDeleted('111', 10)
    const row = getMessages('111', 1)[0]
    expect(row.deleted_ts).not.toBeNull()
    expect(row.text).toBe('')
    expect(searchMessages('секрет')).toHaveLength(0)
  })

  it('deletes by message id alone when Telegram omits the chat', () => {
    makeChat()
    insertMessage({ chat_id: '111', msg_id: 42, direction: 'in', text: 'зникне', ts: 1000 })
    const chatId = markDeletedByMsgId(42)
    expect(chatId).toBe('111')
    expect(getMessages('111', 1)[0].deleted_ts).not.toBeNull()
  })

  it('returns null when the message id is unknown', () => {
    expect(markDeletedByMsgId(999)).toBeNull()
  })
})

describe('search', () => {
  beforeEach(() => {
    makeChat('111')
    makeChat('222', { title: 'Інший' })
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'зустріч у четвер о 15', ts: 1000 })
    insertMessage({ chat_id: '222', msg_id: 2, direction: 'out', text: 'надішлю кошторис у четвер', ts: 2000 })
  })

  it('finds messages across chats', () => {
    expect(searchMessages('четвер')).toHaveLength(2)
  })

  it('scopes to a chat when asked', () => {
    const rows = searchMessages('четвер', { chatId: '222' })
    expect(rows).toHaveLength(1)
    expect(rows[0].chat_id).toBe('222')
  })

  it('returns nothing for an empty query', () => {
    expect(searchMessages('   ')).toHaveLength(0)
  })

  it('survives FTS operator characters in the query', () => {
    expect(() => searchMessages('"* четвер')).not.toThrow()
  })
})

describe('outbox', () => {
  it('records sent and failed actions', () => {
    makeChat()
    recordOutbox({ chat_id: '111', kind: 'message', text: 'привіт', status: 'sent', requested_by: 'ai', msg_id: 7 })
    recordOutbox({ chat_id: '111', kind: 'message', text: 'збій', status: 'failed', error: 'boom', requested_by: 'ai' })
    const rows = listOutbox()
    expect(rows).toHaveLength(2)
    expect(rows.some(r => r.status === 'failed' && r.error === 'boom')).toBe(true)
  })

  it('counts only sent messages for the rate limit', () => {
    makeChat()
    const now = Math.floor(Date.now() / 1000)
    recordOutbox({ chat_id: '111', kind: 'message', status: 'sent' })
    recordOutbox({ chat_id: '111', kind: 'message', status: 'failed' })
    expect(countOutboxSince(now - 60)).toBe(1)
  })
})

describe('owner isolation', () => {
  it('reads as legacy until an account is stamped', () => {
    expect(getOwnerId()).toBe(LEGACY_OWNER)
  })

  it('reports a switch only when a real account was replaced', () => {
    expect(setOwnerId('aaa')).toEqual({ previous: LEGACY_OWNER, changed: false })
    expect(setOwnerId('bbb')).toEqual({ previous: 'aaa', changed: true })
    expect(setOwnerId('bbb')).toEqual({ previous: 'bbb', changed: false })
  })

  it('hides another account rows from every listing', () => {
    setOwnerId('aaa')
    makeChat('111')
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'від першого', ts: 1000 })

    setOwnerId('bbb')
    // Same chat_id, same msg_id — legitimate under a different account.
    makeChat('111')
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'out', text: 'від другого', ts: 2000 })

    expect(getMessages('111').map(m => m.text)).toEqual(['від другого'])
    expect(countMessages().total).toBe(1)
    expect(getRecentMessages(10)).toHaveLength(1)
    expect(searchMessages('другого')).toHaveLength(1)
    expect(searchMessages('першого')).toHaveLength(0)

    setOwnerId('aaa')
    expect(getMessages('111').map(m => m.text)).toEqual(['від першого'])
  })

  it('keeps the read cursor per account', () => {
    setOwnerId('aaa')
    makeChat('111')
    insertMessage({ chat_id: '111', msg_id: 500, direction: 'in', text: 'a', ts: 1000 })
    expect(getCursor('111')).toBe(500)

    setOwnerId('bbb')
    expect(getCursor('111')).toBe(0)
  })

  it('counts and purges rows of other accounts', () => {
    setOwnerId('aaa')
    makeChat('111')
    insertMessage({ chat_id: '111', msg_id: 1, direction: 'in', text: 'старе', ts: 1000 })

    setOwnerId('bbb')
    makeChat('222')
    insertMessage({ chat_id: '222', msg_id: 1, direction: 'in', text: 'нове', ts: 2000 })

    // upsertChat re-claims a chat the current account can see, so only the
    // chat nobody re-registered stays foreign.
    expect(countForeignRows()).toEqual({ chats: 1, messages: 1 })

    const removed = purgeForeignRows()
    expect(removed).toEqual({ chats: 1, messages: 1 })
    expect(countForeignRows()).toEqual({ chats: 0, messages: 0 })
    expect(countMessages().total).toBe(1)
  })
})

describe('people register', () => {
  beforeEach(() => { resetDb() })

  it('builds itself from what the log already sees', () => {
    notePersonSeen({ peer_id: '900', display_name: 'Марта', username: 'marta', ts: 1000 })
    notePersonSeen({ peer_id: '900', display_name: 'Марта', username: 'marta', ts: 2000 })

    const p = getPerson('900')!
    expect(p.display_name).toBe('Марта')
    expect(p.username).toBe('marta')
    expect(p.msg_count).toBe(2)
    expect(p.seen_first).toBe(1000)
    expect(p.seen_last).toBe(2000)
  })

  it('keeps the earliest sighting when messages arrive out of order', () => {
    // Catch-up walks history backwards, so a newer message is often stored first.
    notePersonSeen({ peer_id: '900', display_name: 'Марта', ts: 5000 })
    notePersonSeen({ peer_id: '900', display_name: 'Марта', ts: 1000 })

    const p = getPerson('900')!
    expect(p.seen_first).toBe(1000)
    expect(p.seen_last).toBe(5000)
  })

  it('never lets a Telegram rename wipe the owner\'s own notes', () => {
    notePersonSeen({ peer_id: '900', display_name: 'марта 🌸', ts: 1000 })
    setPersonProfile('900', { canonical_name: 'Марта Коваль', role: 'підрядниця' })

    notePersonSeen({ peer_id: '900', display_name: 'M.', ts: 2000 })

    const p = getPerson('900')!
    expect(p.canonical_name).toBe('Марта Коваль')
    expect(p.role).toBe('підрядниця')
    expect(p.display_name).toBe('M.')
    expect(personName(p)).toBe('Марта Коваль')
  })

  it('does not blank a known name when a later sighting carries none', () => {
    // senderNameFromCache returns '' on a cache miss; that is missing data,
    // not a rename, and must not overwrite what we already know.
    notePersonSeen({ peer_id: '900', display_name: 'Марта', username: 'marta', ts: 1000 })
    notePersonSeen({ peer_id: '900', display_name: '', username: '', ts: 2000 })

    const p = getPerson('900')!
    expect(p.display_name).toBe('Марта')
    expect(p.username).toBe('marta')
  })

  it('finds people by canonical name, handle or alias', () => {
    notePersonSeen({ peer_id: '900', display_name: 'M.', username: 'marta_k', ts: 1000 })
    setPersonProfile('900', { canonical_name: 'Марта Коваль', aliases: 'Мартуся' })

    expect(listPeople({ search: 'марта коваль' })).toHaveLength(1)
    expect(listPeople({ search: 'marta_k' })).toHaveLength(1)
    expect(listPeople({ search: 'мартуся' })).toHaveLength(1)
    expect(listPeople({ search: 'петро' })).toHaveLength(0)
  })

  it('hides bots unless asked for them', () => {
    notePersonSeen({ peer_id: '900', display_name: 'Марта', ts: 1000 })
    notePersonSeen({ peer_id: '901', display_name: 'SomeBot', is_bot: true, ts: 1000 })

    expect(listPeople()).toHaveLength(1)
    expect(listPeople({ includeBots: true })).toHaveLength(2)
  })

  it('scopes people to the session owner', () => {
    setOwnerId('111')
    notePersonSeen({ peer_id: '900', display_name: 'Марта', ts: 1000 })
    setOwnerId('222')
    expect(listPeople()).toHaveLength(0)
    expect(countPeople()).toBe(0)
    setOwnerId('111')
    expect(countPeople()).toBe(1)
  })
})

describe('chat membership', () => {
  beforeEach(() => { resetDb() })

  it('records members who have never written a word', () => {
    syncChatMembers('-100500', [
      { peer_id: '900', display_name: 'Марта' },
      { peer_id: '901', display_name: 'Олесь' },
    ])

    const members = listChatMembers('-100500')
    expect(members.map(m => m.display_name).sort()).toEqual(['Марта', 'Олесь'])
    // Membership is not activity.
    expect(members.every(m => m.msg_count === 0)).toBe(true)
    expect(chatMembersSyncedAt('-100500')).toBeGreaterThan(0)
  })

  it('drops people who left, instead of merging rosters', () => {
    syncChatMembers('-100500', [{ peer_id: '900' }, { peer_id: '901' }])
    syncChatMembers('-100500', [{ peer_id: '900' }])

    expect(listChatMembers('-100500').map(m => m.peer_id)).toEqual(['900'])
    // The person stays in the register — they existed, and the log still
    // carries what they said.
    expect(getPerson('901')).not.toBeNull()
  })

  it('lists a chat\'s people from both membership and the log', () => {
    upsertChat({ chat_id: '-100500', title: 'Група', kind: 'group', defaultMode: 'log-only' })
    // One only ever spoke, the other is only on the roster.
    notePersonSeen({ peer_id: '902', display_name: 'Гість', ts: 1000 })
    insertMessage({ chat_id: '-100500', msg_id: 1, direction: 'in', sender_id: '902', text: 'привіт', ts: 1000 })
    syncChatMembers('-100500', [{ peer_id: '900', display_name: 'Марта' }])

    const ids = listPeople({ chatId: '-100500' }).map(p => p.peer_id).sort()
    expect(ids).toEqual(['900', '902'])
  })

  it('leaves the roster untouched when a sync throws midway', () => {
    syncChatMembers('-100500', [{ peer_id: '900' }])
    expect(() => syncChatMembers('-100500', [
      { peer_id: '901' },
      { peer_id: null as unknown as string },
      { peer_id: '902' },
    ])).not.toThrow()
    // Rows with no id are skipped, not fatal — the rest still lands.
    expect(listChatMembers('-100500').map(m => m.peer_id).sort()).toEqual(['901', '902'])
  })
})

describe('people backfill', () => {
  it('seeds the register from messages already logged', () => {
    resetDb()
    const d = getTgDb()
    d.exec("DELETE FROM tg_meta WHERE key = 'people_backfill'")
    setOwnerId('111')

    insertMessage({ chat_id: '1', msg_id: 1, direction: 'in', sender_id: '900', sender_name: 'Марта', text: 'а', ts: 1000 })
    insertMessage({ chat_id: '1', msg_id: 2, direction: 'in', sender_id: '900', sender_name: 'Марта', text: 'б', ts: 3000 })
    // The owner's own messages are not entries in his own address book.
    insertMessage({ chat_id: '1', msg_id: 3, direction: 'out', sender_id: '111', sender_name: 'Я', text: 'в', ts: 2000 })

    // Re-running init is what a restart does; the backfill happens there.
    closeTgDb()
    resetOwnerCache()
    getTgDb()
    setOwnerId('111')

    const p = getPerson('900')!
    expect(p.display_name).toBe('Марта')
    expect(p.msg_count).toBe(2)
    expect(p.seen_first).toBe(1000)
    expect(p.seen_last).toBe(3000)
    expect(getPerson('111')).toBeNull()
  })
})

describe('api call accounting', () => {
  beforeEach(() => { getTgDb().exec('DELETE FROM tg_api_calls') })

  it('adds up calls per day and per call site', () => {
    noteApiCall('2026-09-06', 'getDialogs')
    noteApiCall('2026-09-06', 'getMessages')
    noteApiCall('2026-09-06', 'getMessages')
    noteApiCall('2026-09-07', 'getDialogs')

    expect(getApiCalls('2026-09-06')).toEqual({
      total: 3, byLabel: { getDialogs: 1, getMessages: 2 },
    })
    expect(getApiCalls('2026-09-07').total).toBe(1)
  })

  it('reports an untouched day as zero rather than nothing', () => {
    expect(getApiCalls('2020-01-01')).toEqual({ total: 0, byLabel: {} })
  })

  it('drops days too old to explain anything', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    noteApiCall(old, 'getDialogs')
    noteApiCall(today, 'getDialogs')

    expect(pruneApiCalls(14)).toBe(1)
    expect(getApiCalls(old).total).toBe(0)
    expect(getApiCalls(today).total).toBe(1)
  })
})
