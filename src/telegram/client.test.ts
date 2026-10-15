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

import { classifyEntity, defaultModeFor, mediaTypeOf, readCredentials, buildVcard, avatarPath, normalizePhone } from './client.js'

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


describe('buildVcard', () => {
  const card = (over: Record<string, unknown> = {}) => ({
    phone: '+380731234567', firstName: 'Капп', lastName: 'Тестовий', note: '', ...over,
  })

  it('names the person the way the owner named them', () => {
    const v = buildVcard(card())
    expect(v).toContain('N:Тестовий;Капп;;;')
    expect(v).toContain('FN:Капп Тестовий')
    expect(v).toContain('TEL;TYPE=cell:+380731234567')
  })

  it('writes the handle the way Apple Contacts itself writes it', () => {
    // Taken from a real exported vCard: the x-apple: scheme and the itemN.
    // grouping are what makes the row render as a tappable Telegram entry
    // rather than being dropped.
    const v = buildVcard(card({ username: 'teapok' }))
    expect(v).toContain('item1.IMPP;X-SERVICE-TYPE=Telegram;type=pref:x-apple:teapok')
    expect(v).toContain('item1.X-ABLabel:Telegram')
  })

  it('repeats the handle in every field an address book might read', () => {
    // Clients disagree about where a messaging identity lives, and for someone
    // with no visible number this is the only way to reach them — so it goes
    // everywhere, down to plain text in NOTE.
    const v = buildVcard(card({ username: 'teapok' }))
    expect(v).toContain('X-SOCIALPROFILE;type=Telegram:x-apple:teapok')
    expect(v).toContain('item2.URL:https://t.me/teapok')
    expect(v).toContain('item2.X-ABLabel:Telegram')
    expect(v).toContain('NOTE:Telegram: @teapok')
    expect(buildVcard(card())).not.toContain('URL:')
  })

  it('carries the numeric id, which outlives a renamed handle', () => {
    expect(buildVcard(card({ telegramId: '1470937341' }))).toContain('X-TELEGRAM-ID:1470937341')
    expect(buildVcard(card())).not.toContain('X-TELEGRAM-ID')
  })

  it('keeps the handle and the comment apart inside NOTE', () => {
    const v = buildVcard(card({ username: 'teapok', note: 'студент КМП-11' }))
    expect(v).toContain('NOTE:Telegram: @teapok — https://t.me/teapok\\nстудент КМП-11')
  })

  it('carries a note only when there is one', () => {
    expect(buildVcard(card())).not.toContain('NOTE:')
    expect(buildVcard(card({ note: 'покрівельник' }))).toContain('NOTE:покрівельник')
  })

  it('leaves out a phone Telegram would not give us', () => {
    // An empty TEL line is worse than none: some clients render it as a blank
    // number and offer to call it.
    expect(buildVcard(card({ phone: '' }))).not.toContain('TEL')
  })

  it('escapes the characters that would otherwise end the field', () => {
    // A semicolon in a name is not exotic — "Іванов; ФОП" is a real way people
    // write themselves — and unescaped it silently splits the vCard field.
    const v = buildVcard(card({ note: 'дах; ремонт, аванс' }))
    expect(v).toContain('NOTE:дах\\; ремонт\\, аванс')
  })

  it('keeps a multi-line note inside one field', () => {
    const v = buildVcard(card({ note: 'перший рядок\nдругий' }))
    expect(v).toContain('NOTE:перший рядок\\nдругий')
    expect(v.split('\r\n').filter(l => l.startsWith('NOTE'))).toHaveLength(1)
  })

  it('uses CRLF, which is what the format actually specifies', () => {
    expect(buildVcard(card()).startsWith('BEGIN:VCARD\r\nVERSION:3.0')).toBe(true)
  })
})

describe('avatarPath', () => {
  it('keys the file by the photo, not only by the person', () => {
    // A changed avatar has to be a different file. Keying by peer id alone
    // would serve yesterday's picture forever, since the cache never expires.
    expect(avatarPath('900', '5')).not.toBe(avatarPath('900', '6'))
    expect(avatarPath('900', '5')).toBe(avatarPath('900', '5'))
    expect(avatarPath('900', '5')).toMatch(/avatars\/900_5\.jpg$/)
  })
})

describe('normalizePhone', () => {
  it('keeps the digits and drops how a person wrote them', () => {
    // Telegram matches on the bare number. A stray space or dash means the
    // import silently resolves to nobody.
    expect(normalizePhone('+380 73 000 00 01')).toBe('+380730000001')
    expect(normalizePhone('(073) 000-00-01')).toBe('0730000001')
    expect(normalizePhone(' 380730000001 ')).toBe('380730000001')
  })

  it('keeps the leading plus, which is not decoration', () => {
    expect(normalizePhone('+380730000001').startsWith('+')).toBe(true)
    expect(normalizePhone('380730000001').startsWith('+')).toBe(false)
  })

  it('reports nothing rather than inventing a number', () => {
    expect(normalizePhone('')).toBe('')
    expect(normalizePhone('  ')).toBe('')
    expect(normalizePhone('не знаю')).toBe('')
  })
})
