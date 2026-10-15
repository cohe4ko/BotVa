import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const createBot = vi.fn((p: { name: string }) => ({ name: p.name, directory: '/x' }))
vi.mock('./bot-manager.js', () => ({ createBot: (p: any) => createBot(p) }))
const startBot = vi.fn()
vi.mock('./admin/bot-control.js', () => ({ startBot: (n: string) => startBot(n) }))

import {
  addPendingRequest, takePendingRequest, suggestUsername, requestKeyboard, canManageBots,
  completeManagedBot, botIdFromToken, replaceTokenInEnv, rotateManagedBotToken, _resetManagedBotsForTests,
} from './managed-bots.js'

const req = (over = {}) => ({ chatId: '42', name: 'sales', displayName: 'Sales', createdAt: Date.now(), ...over })

beforeEach(() => {
  vi.clearAllMocks()
  _resetManagedBotsForTests()
})

describe('pending requests', () => {
  it('are taken once', () => {
    addPendingRequest(req())
    expect(takePendingRequest('42')?.name).toBe('sales')
    expect(takePendingRequest('42')).toBeUndefined()
  })

  it('expire after 30 minutes', () => {
    addPendingRequest(req({ createdAt: 0 }))
    expect(takePendingRequest('42', 31 * 60 * 1000)).toBeUndefined()
  })

  it('belong to their chat', () => {
    addPendingRequest(req())
    expect(takePendingRequest('7')).toBeUndefined()
    expect(takePendingRequest('42')).toBeDefined()
  })
})

describe('suggestUsername', () => {
  it('ends in bot and keeps only allowed characters', () => {
    expect(suggestUsername('sales-team')).toBe('sales_team_bot')
    expect(suggestUsername('newsbot')).toBe('newsbot')
    expect(suggestUsername('---')).toBe('botva_bot')
  })
})

describe('requestKeyboard', () => {
  it('is a one-time request_managed_bot button with our suggestions', () => {
    const kb = requestKeyboard('🤖 Sales', req())
    const button = kb.keyboard[0][0] as any
    expect(button.text).toBe('🤖 Sales')
    expect(button.request_managed_bot).toMatchObject({ suggested_name: 'Sales', suggested_username: 'sales_bot' })
    expect(button.request_managed_bot.request_id).toBeGreaterThan(0)
    expect(button.request_managed_bot.request_id).toBeLessThan(2 ** 31)
    expect(kb.one_time_keyboard).toBe(true)
  })
})

describe('canManageBots', () => {
  it('reads can_manage_bots from getMe and is false on failure', async () => {
    expect(await canManageBots({ getMe: async () => ({ can_manage_bots: true }) } as any)).toBe(true)
    expect(await canManageBots({ getMe: async () => ({}) } as any)).toBe(false)
    expect(await canManageBots({ getMe: async () => { throw new Error('net') } } as any)).toBe(false)
  })
})

describe('completeManagedBot', () => {
  it('creates the bot with its token, restricts access to the owner and starts it', async () => {
    const api = {
      getManagedBotToken: vi.fn(async () => '123:abc'),
      setManagedBotAccessSettings: vi.fn(async () => true),
    }
    const line = await completeManagedBot(api as any, req({ role: 'researcher', autoStart: true }), { id: 123, username: 'sales_bot' })
    expect(api.getManagedBotToken).toHaveBeenCalledWith(123)
    expect(createBot).toHaveBeenCalledWith(expect.objectContaining({ name: 'sales', token: '123:abc', role: 'researcher', chatId: '42' }))
    expect(api.setManagedBotAccessSettings).toHaveBeenCalledWith(123, true)
    expect(startBot).toHaveBeenCalledWith('sales')
    expect(line).toContain('@sales_bot')
  })

  it('still creates the bot when restricting access fails', async () => {
    const api = {
      getManagedBotToken: vi.fn(async () => '123:abc'),
      setManagedBotAccessSettings: vi.fn(async () => { throw new Error('nope') }),
    }
    await completeManagedBot(api as any, req(), { id: 123 })
    expect(createBot).toHaveBeenCalled()
    expect(startBot).not.toHaveBeenCalled()
  })
})

describe('tokens', () => {
  it('botIdFromToken takes the numeric part before the colon', () => {
    expect(botIdFromToken('123456:AAE-secret')).toBe(123456)
    expect(botIdFromToken('garbage')).toBeUndefined()
  })

  it('replaceTokenInEnv swaps only the token line', () => {
    expect(replaceTokenInEnv('A=1\nTELEGRAM_BOT_TOKEN=old\nB=2', 'new')).toBe('A=1\nTELEGRAM_BOT_TOKEN=new\nB=2')
    expect(replaceTokenInEnv('A=1', 'new')).toBe('TELEGRAM_BOT_TOKEN=new\nA=1')
  })

  it('rotateManagedBotToken asks Telegram for a new token and writes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'managed-'))
    mkdirSync(join(root, 'bots', 'sales'), { recursive: true })
    writeFileSync(join(root, 'bots', 'sales', '.env'), 'TELEGRAM_BOT_TOKEN="555:old"\nX=1\n')
    const api = { replaceManagedBotToken: vi.fn(async () => '555:new') }
    await rotateManagedBotToken(api as any, root, 'sales')
    expect(api.replaceManagedBotToken).toHaveBeenCalledWith(555)
    expect(readFileSync(join(root, 'bots', 'sales', '.env'), 'utf-8')).toBe('TELEGRAM_BOT_TOKEN=555:new\nX=1\n')
  })

  it('rotateManagedBotToken refuses an unknown bot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'managed-'))
    await expect(rotateManagedBotToken({} as any, root, 'ghost')).rejects.toThrow('not found')
  })
})
