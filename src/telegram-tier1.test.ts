import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'

const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-tg-tier1-'))
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

// The runner reaches into the bot runtime to write facts and reminders; the
// parts under test here are the chunk it builds and when it wakes up.
vi.mock('./env.js', () => ({ BOT_NAME: 'cap', BOT_DIR: testDir, readEnvFile: () => ({}) }))
vi.mock('./config.js', () => ({ ALLOWED_CHAT_ID: '', STORE_DIR: testDir, PROJECT_ROOT: testDir }))
vi.mock('./model.js', () => ({
  getBackgroundModel: () => 'haiku',
  parseModelConfig: () => ({ model: 'claude-haiku-4-5-20251001' }),
}))
vi.mock('./db.js', () => ({
  insertReminder: vi.fn(() => 1),
  getFactsWithEmbeddings: vi.fn(() => []),
  boostFactUsefulness: vi.fn(),
}))
vi.mock('./admin/db-multi.js', () => ({ insertFactForBot: vi.fn(() => 1) }))
vi.mock('./embeddings.js', () => ({ embed: vi.fn(async () => null), cosineSim: vi.fn(() => 0) }))
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  getTgDb, closeTgDb, upsertChat, insertMessage, setOwnerId, resetOwnerCache,
  notePersonSeen, setPersonProfile, setAnalysisTarget, listAnalysisTargets,
  getUnanalysedMessages, markAnalysed, recordExtraction, listExtractions,
  markExtractionsStale, getExtraction, noteTier1Call, getBudget,
  type TgPerson,
} from './telegram/db.js'
import { renderTranscript, participantLines, nextSleepMs } from './telegram-tier1.js'

const NOW = 1_800_000_000

function resetDb(): void {
  const d = getTgDb()
  for (const t of ['tg_messages', 'tg_messages_fts', 'tg_chats', 'tg_people',
    'tg_chat_members', 'tg_extractions', 'tg_budget']) {
    d.exec(`DELETE FROM ${t}`)
  }
  d.exec("DELETE FROM tg_meta WHERE key = 'owner_id'")
  resetOwnerCache()
  setOwnerId('42')
}

beforeEach(() => { resetDb() })
afterAll(() => {
  closeTgDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('transcript for analysis', () => {
  it('labels the owner and carries every message id', () => {
    // The whole prompt turns on telling his lines from theirs, and the model is
    // required to cite ids it can only have seen here.
    const rows = [
      { msg_id: 11, direction: 'in', sender_id: '900', sender_name: 'Марта', text: 'привезу в четвер', media_type: null, reply_to: null, ts: NOW, deleted_ts: null },
      { msg_id: 12, direction: 'out', sender_id: '42', sender_name: '', text: 'домовились', media_type: null, reply_to: 11, ts: NOW + 60, deleted_ts: null },
    ] as never

    const out = renderTranscript(rows, new Map(), 'Марта')
    expect(out).toContain('#11')
    expect(out).toContain('#12')
    expect(out).toContain('ВЛАСНИК')
    expect(out).toContain('у відповідь на #11')
  })

  it('prefers the owner\'s own name for a person over Telegram\'s', () => {
    const people = new Map<string, TgPerson>([
      ['900', { peer_id: '900', canonical_name: 'Марта Коваль', display_name: 'мартуся 🌸' } as TgPerson],
    ])
    const rows = [
      { msg_id: 11, direction: 'in', sender_id: '900', sender_name: 'мартуся 🌸', text: 'ок', media_type: null, reply_to: null, ts: NOW, deleted_ts: null },
    ] as never

    const out = renderTranscript(rows, people, 'чат')
    expect(out).toContain('Марта Коваль')
    expect(out).not.toContain('мартуся')
  })

  it('drops tombstones, which carry nothing to analyse', () => {
    const rows = [
      { msg_id: 11, direction: 'in', sender_id: '900', sender_name: 'Марта', text: '', media_type: null, reply_to: null, ts: NOW, deleted_ts: NOW },
      { msg_id: 12, direction: 'in', sender_id: '900', sender_name: 'Марта', text: 'живе', media_type: null, reply_to: null, ts: NOW, deleted_ts: null },
    ] as never
    expect(renderTranscript(rows, new Map(), 'чат')).toBe(
      renderTranscript([rows[1]] as never, new Map(), 'чат'))
  })
})

describe('participant lines', () => {
  it('carries the role, which is what makes a fact mean anything', () => {
    notePersonSeen({ peer_id: '900', display_name: 'Марта', username: 'marta', ts: NOW })
    setPersonProfile('900', { canonical_name: 'Марта Коваль', role: 'підрядниця', note: 'дах' })

    const lines = participantLines([...listPeopleForTest()])
    expect(lines[0]).toContain('Марта Коваль')
    expect(lines[0]).toContain('@marta')
    expect(lines[0]).toContain('підрядниця')
    expect(lines[0]).toContain('дах')
  })
})

function listPeopleForTest(): TgPerson[] {
  return getTgDb().prepare('SELECT * FROM tg_people').all() as unknown as TgPerson[]
}

describe('routing', () => {
  it('analyses nothing until a chat names a bot', () => {
    upsertChat({ chat_id: '1', title: 'Марта', kind: 'user', defaultMode: 'full' })
    insertMessage({ chat_id: '1', msg_id: 1, direction: 'in', text: 'привіт', ts: NOW })

    expect(listAnalysisTargets('cap')).toHaveLength(0)
    setAnalysisTarget('1', 'cap')
    expect(listAnalysisTargets('cap')).toHaveLength(1)
  })

  it('ignores chats that are only logged', () => {
    upsertChat({ chat_id: '1', title: 'Марта', kind: 'user', defaultMode: 'log-only' })
    setAnalysisTarget('1', 'cap')
    expect(listAnalysisTargets('cap')).toHaveLength(0)
  })

  it('starts from the present, not from months of backlog', () => {
    // Switching analysis on must not send a year of history to the model.
    upsertChat({ chat_id: '1', title: 'Марта', kind: 'user', defaultMode: 'full' })
    for (let i = 1; i <= 5; i++) {
      insertMessage({ chat_id: '1', msg_id: i, direction: 'in', text: `стара ${i}`, ts: NOW - 86400 })
    }
    setAnalysisTarget('1', 'cap')

    expect(listAnalysisTargets('cap')[0]!.pending).toBe(0)
    insertMessage({ chat_id: '1', msg_id: 6, direction: 'in', text: 'нова', ts: NOW })
    expect(listAnalysisTargets('cap')[0]!.pending).toBe(1)
    expect(getUnanalysedMessages('1', 5).map(m => m.msg_id)).toEqual([6])
  })

  it('means "from now on" every time it is switched on', () => {
    upsertChat({ chat_id: '1', title: 'Марта', kind: 'user', defaultMode: 'full' })
    setAnalysisTarget('1', 'cap')
    setAnalysisTarget('1', '')
    for (let i = 1; i <= 3; i++) {
      insertMessage({ chat_id: '1', msg_id: i, direction: 'in', text: `поки вимкнено ${i}`, ts: NOW })
    }
    setAnalysisTarget('1', 'cap')

    // Whatever accumulated while analysis was off stays in the log and out of
    // the model. Switching it back on must not hand over a surprise backlog.
    expect(listAnalysisTargets('cap')[0]!.pending).toBe(0)
  })

  it('does not rewind when the same bot is saved again', () => {
    // Re-saving an unchanged setting in the admin panel must not skip whatever
    // is waiting.
    upsertChat({ chat_id: '1', title: 'Марта', kind: 'user', defaultMode: 'full' })
    setAnalysisTarget('1', 'cap')
    insertMessage({ chat_id: '1', msg_id: 1, direction: 'in', text: 'нова', ts: NOW })
    setAnalysisTarget('1', 'cap')

    expect(listAnalysisTargets('cap')[0]!.pending).toBe(1)
  })
})

describe('extractions', () => {
  const base = {
    chat_id: '1', kind: 'facts', target_bot: 'cap', text: 'Марта привезе документи',
    quote: 'привезу в четвер', confidence: 0.9,
  }

  it('flags derived items when their source message is edited away', () => {
    const id = recordExtraction({ ...base, msg_ids: [11, 12], status: 'saved' })
    expect(markExtractionsStale(11, '1')).toBe(1)
    expect(getExtraction(id)!.status).toBe('stale')
  })

  it('does not confuse message 12 with message 1', () => {
    // The JSON text is filtered with LIKE, so "1" would match "[11,12]" — the
    // real test has to run on parsed ids.
    const id = recordExtraction({ ...base, msg_ids: [11, 12], status: 'saved' })
    expect(markExtractionsStale(1, '1')).toBe(0)
    expect(getExtraction(id)!.status).toBe('saved')
  })

  it('leaves already-declined items alone', () => {
    const id = recordExtraction({ ...base, msg_ids: [11], status: 'declined' })
    markExtractionsStale(11, '1')
    expect(getExtraction(id)!.status).toBe('declined')
  })

  it('lists the review queue separately from what was saved', () => {
    recordExtraction({ ...base, msg_ids: [1], status: 'pending' })
    recordExtraction({ ...base, msg_ids: [2], status: 'saved' })
    recordExtraction({ ...base, msg_ids: [3], status: 'dropped' })

    expect(listExtractions({ status: 'pending' })).toHaveLength(1)
    expect(listExtractions()).toHaveLength(3)
  })
})

describe('budget', () => {
  it('counts calls for the current day', () => {
    expect(getBudget().tier1_calls).toBe(0)
    noteTier1Call()
    noteTier1Call()
    expect(getBudget().tier1_calls).toBe(2)
  })
})

describe('sleep between passes', () => {
  const target = (over: Record<string, unknown> = {}) => ({
    chat_id: '1', title: 'ч', kind: 'user', mode: 'full', target_bot: 'cap',
    analyzed_msg_id: 0, last_flush_ts: 0, pending: 2,
    oldest_ts: NOW - 30, newest_ts: NOW - 30, ...over,
  }) as never

  it('sleeps long when no chat has anything waiting', () => {
    expect(nextSleepMs([target({ pending: 0 })], NOW)).toBe(5 * 60_000)
    expect(nextSleepMs([], NOW)).toBe(5 * 60_000)
  })

  it('never busy-loops, even on a chat that is due right now', () => {
    expect(nextSleepMs([target({ pending: 25 })], NOW)).toBe(30_000)
  })

  it('follows the chat that comes due soonest', () => {
    const soon = target({ newest_ts: NOW - 200 })
    const later = target({ chat_id: '2', newest_ts: NOW })
    expect(nextSleepMs([soon, later], NOW)).toBe(nextSleepMs([soon], NOW))
  })
})
