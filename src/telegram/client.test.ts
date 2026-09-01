import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'

const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-tg-client-'))
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

// getPeerId does real entity resolution; the marked-id shape is all we assert on.
vi.mock('telegram/Utils.js', () => ({
  getPeerId: (e: { id?: unknown; className?: string }) => {
    const raw = String(e.id ?? '0')
    return e.className === 'Channel' ? `-100${raw}` : raw
  },
  getDisplayName: (e: { title?: string; firstName?: string }) => e.title ?? e.firstName ?? '',
}))

import { classifyEntity, defaultModeFor, mediaTypeOf, readCredentials } from './client.js'

describe('classifyEntity', () => {
  it('separates humans from bots', () => {
    expect(classifyEntity({ className: 'User', id: 5, firstName: 'Петро' })!.kind).toBe('user')
    expect(classifyEntity({ className: 'User', id: 6, firstName: 'BotVa', bot: true })!.kind).toBe('bot')
  })

  it('separates supergroups from broadcast channels', () => {
    expect(classifyEntity({ className: 'Channel', id: 7, title: 'Робоча', megagroup: true })!.kind).toBe('supergroup')
    expect(classifyEntity({ className: 'Channel', id: 8, title: 'Новини' })!.kind).toBe('channel')
  })

  it('treats basic and forbidden chats as groups', () => {
    expect(classifyEntity({ className: 'Chat', id: 9, title: 'Сімʼя' })!.kind).toBe('group')
    expect(classifyEntity({ className: 'ChatForbidden', id: 10, title: 'Закрита' })!.kind).toBe('group')
  })

  it('uses the marked id for channels', () => {
    expect(classifyEntity({ className: 'Channel', id: 7, title: 'X', megagroup: true })!.chat_id).toBe('-1007')
    expect(classifyEntity({ className: 'User', id: 7, firstName: 'X' })!.chat_id).toBe('7')
  })

  it('falls back to the id when there is no display name', () => {
    expect(classifyEntity({ className: 'User', id: 11 })!.title).toBe('11')
  })

  it('returns null for unknown shapes', () => {
    expect(classifyEntity(null)).toBeNull()
    expect(classifyEntity({ className: 'MessageService' })).toBeNull()
    expect(classifyEntity('not an entity')).toBeNull()
  })
})

describe('defaultModeFor', () => {
  it('hard-ignores bots so the observer never reads BotVa output', () => {
    expect(defaultModeFor('bot')).toBe('ignore')
  })

  it('logs private chats and basic groups', () => {
    expect(defaultModeFor('user')).toBe('log-only')
    expect(defaultModeFor('group')).toBe('log-only')
  })

  it('skips supergroups and channels', () => {
    expect(defaultModeFor('supergroup')).toBe('ignore')
    expect(defaultModeFor('channel')).toBe('ignore')
  })
})

describe('mediaTypeOf', () => {
  it('names common attachments', () => {
    expect(mediaTypeOf({ media: { className: 'MessageMediaPhoto' } })).toBe('photo')
    expect(mediaTypeOf({ media: { className: 'MessageMediaDocument' } })).toBe('document')
    expect(mediaTypeOf({ media: { className: 'MessageMediaGeo' } })).toBe('location')
  })

  it('does not treat a link preview as an attachment', () => {
    expect(mediaTypeOf({ media: { className: 'MessageMediaWebPage' } })).toBeNull()
  })

  it('returns null when there is no media', () => {
    expect(mediaTypeOf({})).toBeNull()
  })

  it('degrades gracefully for unknown media classes', () => {
    expect(mediaTypeOf({ media: { className: 'MessageMediaDice' } })).toBe('dice')
  })
})

describe('readCredentials', () => {
  it('reports absence instead of guessing', () => {
    expect(readCredentials({} as NodeJS.ProcessEnv)).toBeNull()
    expect(readCredentials({ TELEGRAM_API_ID: '123' } as unknown as NodeJS.ProcessEnv)).toBeNull()
  })

  it('reads a complete pair', () => {
    const creds = readCredentials({
      TELEGRAM_API_ID: '123456',
      TELEGRAM_API_HASH: 'abcdef',
    } as unknown as NodeJS.ProcessEnv)
    expect(creds).toEqual({ apiId: 123456, apiHash: 'abcdef' })
  })
})
