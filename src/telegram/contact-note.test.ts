import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'

const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-tg-note-'))
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

// The tools under test are thin over MTProto; what is worth testing is
// what they refuse and what they mirror, so Telegram itself is a stub.
const tg = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  add: vi.fn(),
  send: vi.fn(),
  sendFile: vi.fn(),
  importByPhone: vi.fn(),
}))

vi.mock('./client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readContactNote: tg.read,
  writeContactNote: tg.write,
  addContact: tg.add,
  sendContact: tg.send,
  sendVcardFile: tg.sendFile,
  importContactByPhone: tg.importByPhone,
}))

import { __testing } from './mcp.js'
import { TELEGRAM_SENDING_TOOLS, telegramSendingToolIds } from './tool-names.js'
import {
  getTgDb, closeTgDb, setOwnerId, resetOwnerCache, notePersonSeen, getPerson,
  setPersonProfile, upsertChat, setChatCanSend, listOutbox,
} from './db.js'

const { callTool } = __testing
const CLIENT = {} as never
const NOW = 1_800_000_000

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await callTool(CLIENT, name, args, 'test')
  return { text: res.content[0]!.text, failed: res.isError === true }
}

const profile = (over: Record<string, unknown> = {}) => ({
  peer_id: '900', display_name: 'Марта Коваль', username: 'marta',
  phone: '', is_contact: true, note: '', avatar: null, ...over,
})

beforeEach(() => {
  const d = getTgDb()
  d.exec('DELETE FROM tg_people')
  d.exec('DELETE FROM tg_chats')
  d.exec('DELETE FROM tg_outbox')
  d.exec("DELETE FROM tg_meta WHERE key = 'owner_id'")
  resetOwnerCache()
  setOwnerId('42')
  vi.clearAllMocks()
  notePersonSeen({ peer_id: '900', display_name: 'Марта', username: 'marta', ts: NOW })
})

afterAll(() => {
  closeTgDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('tg_contact_note', () => {
  it('says whether the person is a contact, not only what the note says', () => {
    // An empty note on a non-contact and an empty note on a contact mean
    // different things: the first cannot be written, the second can.
    tg.read.mockResolvedValue(profile({ is_contact: false }))
    return call('tg_contact_note', { peer: '900' }).then(r => {
      expect(r.text).toContain('не в контактах')
      expect(r.text).toContain('нотатки немає')
    })
  })

  it('hands back the avatar as a path, not as an image', async () => {
    // The file is already on disk and stays there. Pulling the picture itself
    // through the model on every profile read would cost tokens for a byte
    // stream nobody reads.
    tg.read.mockResolvedValue(profile({ avatar: '/tmp/avatars/900_5.jpg' }))
    const r = await call('tg_contact_note', { peer: '900' })
    expect(r.text).toContain('Аватар: /tmp/avatars/900_5.jpg')
  })

  it('says nothing about an avatar when there is none', async () => {
    tg.read.mockResolvedValue(profile())
    expect((await call('tg_contact_note', { peer: '900' })).text).not.toContain('Аватар')
  })

  it('shows the note Telegram holds', async () => {
    tg.read.mockResolvedValue(profile({ note: 'підрядниця, дах' }))
    const r = await call('tg_contact_note', { peer: '900' })
    expect(r.text).toContain('підрядниця, дах')
    expect(r.text).toContain('у контактах')
  })
})

describe('tg_write_note', () => {
  it('refuses someone who is not a contact instead of adding them', async () => {
    // Adding a contact is a visible change to the owner's account. Doing it as
    // a side effect of writing a note would be a decision made for him.
    tg.read.mockResolvedValue(profile({ is_contact: false }))
    const r = await call('tg_write_note', { peer: '900', note: 'щось' })

    expect(r.failed).toBe(true)
    expect(r.text).toContain('tg_add_contact')
    expect(tg.write).not.toHaveBeenCalled()
  })

  it('writes to Telegram and mirrors into our own register', async () => {
    tg.read.mockResolvedValue(profile())
    tg.write.mockResolvedValue(true)

    const r = await call('tg_write_note', { peer: '900', note: 'підрядниця, дах' })

    expect(r.failed).toBe(false)
    expect(tg.write).toHaveBeenCalledWith(CLIENT, '900', 'підрядниця, дах')
    expect(getPerson('900')?.note).toBe('підрядниця, дах')
  })

  it('leaves our note alone when asked to touch only Telegram', async () => {
    setPersonProfile('900', { note: 'наша нотатка' })
    tg.read.mockResolvedValue(profile())
    tg.write.mockResolvedValue(true)

    await call('tg_write_note', { peer: '900', note: 'інше', sync_local: false })
    expect(getPerson('900')?.note).toBe('наша нотатка')
  })

  it('clears the note on an empty string rather than refusing it', async () => {
    tg.read.mockResolvedValue(profile({ note: 'старе' }))
    tg.write.mockResolvedValue(true)

    const r = await call('tg_write_note', { peer: '900', note: '' })
    expect(r.text).toContain('стерто')
    expect(tg.write).toHaveBeenCalledWith(CLIENT, '900', '')
  })

  it('reports a refusal from Telegram instead of claiming success', async () => {
    tg.read.mockResolvedValue(profile())
    tg.write.mockResolvedValue(false)

    const r = await call('tg_write_note', { peer: '900', note: 'щось' })
    expect(r.failed).toBe(true)
    expect(getPerson('900')?.note).toBe('')
  })
})

describe('tg_add_contact', () => {
  it('never shares the phone number unless asked in so many words', async () => {
    tg.add.mockResolvedValue({ peer_id: '900', display_name: 'Марта Коваль', is_contact: true, note: '' })
    await call('tg_add_contact', { peer: '900', first_name: 'Марта' })

    expect(tg.add).toHaveBeenCalledWith(CLIENT, '900', expect.objectContaining({ sharePhone: false }))
  })

  it('passes the flag through when the owner did ask', async () => {
    tg.add.mockResolvedValue({ peer_id: '900', display_name: 'Марта', is_contact: true, note: '' })
    await call('tg_add_contact', { peer: '900', first_name: 'Марта', share_phone: true })

    expect(tg.add).toHaveBeenCalledWith(CLIENT, '900', expect.objectContaining({ sharePhone: true }))
  })

  it('demands a name, because Telegram will show it instead of theirs', async () => {
    const r = await call('tg_add_contact', { peer: '900', first_name: '  ' })
    expect(r.failed).toBe(true)
    expect(tg.add).not.toHaveBeenCalled()
  })

  it('does not claim success when the person stayed out of contacts', async () => {
    // Telegram accepts addContact and silently does nothing when the other
    // side's privacy settings forbid it.
    tg.add.mockResolvedValue({ peer_id: '900', display_name: 'Марта', is_contact: false, note: '' })
    const r = await call('tg_add_contact', { peer: '900', first_name: 'Марта' })

    expect(r.failed).toBe(true)
    expect(r.text).toContain('приватност')
  })

  it('keeps the note it just set in our register too', async () => {
    tg.add.mockResolvedValue({ peer_id: '900', display_name: 'Марта', is_contact: true, note: 'підрядниця' })
    await call('tg_add_contact', { peer: '900', first_name: 'Марта', note: 'підрядниця' })

    expect(getPerson('900')?.note).toBe('підрядниця')
  })
})

describe('tg_import_contact', () => {
  it('passes the number through and mirrors the note into our register', async () => {
    tg.importByPhone.mockResolvedValue({
      peer_id: '900', display_name: 'Марта Коваль', phone: '+380730000001',
      imported: true, reason: '',
    })

    const r = await call('tg_import_contact', {
      phone: '+380 73 000 00 01', first_name: 'Марта', note: 'підрядниця',
    })

    expect(r.failed).toBe(false)
    expect(r.text).toContain('+380730000001')
    expect(getPerson('900')?.note).toBe('підрядниця')
  })

  it('says why nothing was found instead of reporting success', async () => {
    // An unmatched number is the normal answer for someone not on Telegram, and
    // the caller has to be able to tell that from a contact that was added.
    tg.importByPhone.mockResolvedValue({
      peer_id: null, display_name: 'Марта', phone: '+380000000000',
      imported: false, reason: 'На цьому номері немає акаунта Telegram',
    })

    const r = await call('tg_import_contact', { phone: '+380000000000', first_name: 'Марта' })
    expect(r.failed).toBe(true)
    expect(r.text).toContain('немає акаунта')
  })

  it('demands both a number and a name', async () => {
    expect((await call('tg_import_contact', { first_name: 'Марта' })).failed).toBe(true)
    expect((await call('tg_import_contact', { phone: '+380730000001', first_name: ' ' })).failed).toBe(true)
    expect(tg.importByPhone).not.toHaveBeenCalled()
  })
})

describe('tg_add_contact phone', () => {
  it('carries a number through when one is known', async () => {
    // A contact with no number cannot be shared as a card at all, so the number
    // is worth setting at the moment the contact is created.
    tg.add.mockResolvedValue({ peer_id: '900', display_name: 'Марта', is_contact: true, note: '' })
    await call('tg_add_contact', { peer: '900', first_name: 'Марта', phone: '+380 73 000 00 01' })

    expect(tg.add.mock.calls[0]![2].phone).toBe('+380 73 000 00 01')
  })
})

describe('the list of tools that speak to other people', () => {
  it('names every tg_send_* tool that exists', () => {
    // Scheduled agents get Telegram with these withheld. A new sending tool
    // that nobody adds here would quietly be handed to unattended runs, so the
    // list is checked against reality rather than trusted.
    const sending = __testing.TOOLS.map(t => t.name).filter(n => n.startsWith('tg_send_'))
    expect(sending.sort()).toEqual([...TELEGRAM_SENDING_TOOLS].sort())
  })

  it('leaves the tools that only touch the owner\'s own account alone', () => {
    // Notes and contacts live inside his account and are reversible; a message
    // to another person is not. That is the line, not "writes anything".
    const withheld = TELEGRAM_SENDING_TOOLS as readonly string[]
    expect(withheld).not.toContain('tg_write_note')
    expect(withheld).not.toContain('tg_add_contact')
    expect(withheld).not.toContain('tg_import_contact')
    expect(withheld).not.toContain('tg_name_person')
  })

  it('names them the way the agent SDK does', () => {
    expect(telegramSendingToolIds()).toContain('mcp__telegram__tg_send_message')
  })
})

describe('tools list', () => {
  it('carries all five, so a bot can find them', () => {
    const names = __testing.TOOLS.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'tg_contact_note', 'tg_write_note', 'tg_add_contact', 'tg_send_contact',
      'tg_import_contact']))
  })
})

describe('tg_send_contact', () => {
  const OPEN = { chat_id: '55', title: 'Сергій', kind: 'user' as const, defaultMode: 'full' as const }

  const allowSending = () => {
    upsertChat(OPEN)
    setChatCanSend('55', true)
  }

  it('refuses a chat the owner has not opened for sending', async () => {
    upsertChat(OPEN) // registered, but the send checkbox is off
    const r = await call('tg_send_contact', { chat: '55', peer: '900' })

    expect(r.failed).toBe(true)
    expect(tg.send).not.toHaveBeenCalled()
  })

  it('never passes a private note along as the comment', async () => {
    // The whole point of the private note is that it goes nowhere. Only what
    // the caller wrote for this handover may travel.
    setPersonProfile('900', { note: 'винен 20к, тягне з термінами' })
    allowSending()
    tg.send.mockResolvedValue({ msg_id: 7, display_name: 'Марта Коваль', phone_known: true })

    await call('tg_send_contact', { chat: '55', peer: '900' })

    expect(tg.send).toHaveBeenCalledWith(CLIENT, '55', '900', { comment: '', attachNote: false })
  })

  it('passes a comment the caller wrote deliberately', async () => {
    allowSending()
    tg.send.mockResolvedValue({ msg_id: 7, display_name: 'Марта Коваль', phone_known: true })

    await call('tg_send_contact', { chat: '55', peer: '900', comment: 'покрівельник' })
    expect(tg.send).toHaveBeenCalledWith(CLIENT, '55', '900', { comment: 'покрівельник', attachNote: false })
  })

  it('puts nothing inside the card unless asked in so many words', async () => {
    // A note inside the vCard is invisible in every Telegram client but lands
    // in the recipient's address book. That is a decision, never a default.
    allowSending()
    tg.send.mockResolvedValue({ msg_id: 7, display_name: 'Марта', phone_known: true, note_attached: false })

    await call('tg_send_contact', { chat: '55', peer: '900', comment: 'покрівельник' })
    expect(tg.send.mock.calls[0]![3].attachNote).toBe(false)
  })

  it('attaches the comment to the card when asked', async () => {
    allowSending()
    tg.send.mockResolvedValue({ msg_id: 7, display_name: 'Марта', phone_known: true, note_attached: true })

    const r = await call('tg_send_contact', { chat: '55', peer: '900', comment: 'покрівельник', attach_note: true })
    expect(tg.send).toHaveBeenCalledWith(CLIENT, '55', '900', { comment: 'покрівельник', attachNote: true })
    expect(r.text).toContain('вкладено і в саму картку')
  })

  it('refuses to attach nothing', async () => {
    allowSending()
    const r = await call('tg_send_contact', { chat: '55', peer: '900', attach_note: true })

    expect(r.failed).toBe(true)
    expect(tg.send).not.toHaveBeenCalled()
  })

  it('explains a missing phone instead of relaying MEDIA_EMPTY', async () => {
    // A contact card is addressed by phone; someone added one-sidedly never
    // gave theirs. Telegram answers MEDIA_EMPTY, which tells the caller nothing
    // about what to do instead.
    allowSending()
    tg.send.mockRejectedValue(new Error(
      'Марта (@marta) не має номера, видимого власнику, а картка контакту без номера в Telegram не існує. Надішли ці дані текстом — ім\'я, @нік і те, що треба пояснити.'))

    const r = await call('tg_send_contact', { chat: '55', peer: '900' })
    expect(r.failed).toBe(true)
    expect(r.text).toContain('текстом')
    expect(r.text).toContain('@marta')
    expect(listOutbox(10)[0]!.status).toBe('failed')
  })

  it('sends a file instead of a card when asked, and says which it was', async () => {
    // The card and the file are different messages for the recipient, so the
    // switch is explicit and the answer names what actually went.
    allowSending()
    tg.sendFile.mockResolvedValue({ msg_id: 9, display_name: 'Марта', phone_known: false, note_attached: false })

    const r = await call('tg_send_contact', { chat: '55', peer: '900', as_file: true })

    expect(tg.sendFile).toHaveBeenCalled()
    expect(tg.send).not.toHaveBeenCalled()
    expect(r.text).toContain('.vcf')
    expect(listOutbox(10)[0]!.text).toContain('vcf:')
  })

  it('does not warn about a missing phone when sending a file', async () => {
    // The warning belongs to the card, which cannot exist without a number.
    // A file can, so repeating it there would be noise.
    allowSending()
    tg.sendFile.mockResolvedValue({ msg_id: 9, display_name: 'Марта', phone_known: false, note_attached: false })

    const r = await call('tg_send_contact', { chat: '55', peer: '900', as_file: true })
    expect(r.text).not.toContain('без нього')
  })

  it('marks in the journal that the text went inside the card', async () => {
    allowSending()
    tg.send.mockResolvedValue({ msg_id: 7, display_name: 'Марта', phone_known: true, note_attached: true })

    await call('tg_send_contact', { chat: '55', peer: '900', comment: 'покрівельник', attach_note: true })
    expect(listOutbox(10)[0]!.text).toContain('[у картці]')
  })

  it('says so when the card went without a number', async () => {
    allowSending()
    tg.send.mockResolvedValue({ msg_id: 7, display_name: 'Марта Коваль', phone_known: false })

    const r = await call('tg_send_contact', { chat: '55', peer: '900' })
    expect(r.text).toContain('без нього')
  })

  it('records the handover by name, because it is a disclosure', async () => {
    allowSending()
    tg.send.mockResolvedValue({ msg_id: 7, display_name: 'Марта Коваль', phone_known: true })

    await call('tg_send_contact', { chat: '55', peer: '900', comment: 'покрівельник' })
    const row = listOutbox(10)[0]!

    expect(row.kind).toBe('contact')
    expect(row.text).toContain('Марта Коваль')
    expect(row.text).toContain('покрівельник')
    expect(row.status).toBe('sent')
  })

  it('journals a failure instead of losing it', async () => {
    allowSending()
    tg.send.mockRejectedValue(new Error('USER_PRIVACY_RESTRICTED'))

    const r = await call('tg_send_contact', { chat: '55', peer: '900' })
    expect(r.failed).toBe(true)
    expect(listOutbox(10)[0]!.status).toBe('failed')
  })
})
