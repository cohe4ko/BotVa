import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', () => ({
  ALLOWED_CHAT_ID: '42', BOT_NAME: 'test', TELEGRAM_BOT_TOKEN: '', TGAP_ENABLED: false,
  TGAP_OWNER_NAME: '', TGAP_ACCEPT_FROM: 'anyone', TGAP_DRAFT_TOOLS: [],
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../agent.js', () => ({ runAgent: vi.fn() }))
vi.mock('../model.js', () => ({ getModel: () => 'm' }))
vi.mock('../memory.js', () => ({ appendEventToDailyLog: vi.fn() }))

import { tgapMiddleware, draftServers, buildCard } from './runtime.js'

describe('tgapMiddleware (TGAP disabled)', () => {
  it('swallows private messages from bots so nothing answers them', async () => {
    const next = vi.fn()
    await tgapMiddleware({ message: { message_id: 1, text: 'hi' }, chat: { type: 'private' }, from: { id: 7, is_bot: true } } as any, next)
    expect(next).not.toHaveBeenCalled()
  })

  it('passes everything else through', async () => {
    const next = vi.fn()
    await tgapMiddleware({ message: { message_id: 1, text: 'hi' }, chat: { type: 'private' }, from: { id: 42, is_bot: false } } as any, next)
    await tgapMiddleware({ message: { message_id: 2, text: 'hi' }, chat: { type: 'group' }, from: { id: 7, is_bot: true } } as any, next)
    expect(next).toHaveBeenCalledTimes(2)
  })
})

describe('helpers', () => {
  it('derives MCP servers from extra draft tools', () => {
    expect(draftServers(['mcp__calendar__list_events', 'mcp__calendar__free_busy', 'mcp__crm__find'])).toEqual(['calendar', 'crm'])
  })

  it('publishes nothing about the owner by default', () => {
    expect(buildCard().owner.display_name).toBe('the owner')
    expect(buildCard().approval).toBe('owner_always')
  })
})
